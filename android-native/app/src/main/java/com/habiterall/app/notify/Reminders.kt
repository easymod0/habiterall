package com.habiterall.app.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.habiterall.app.data.Entry
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Sentinels
import com.habiterall.app.data.Settings
import com.habiterall.app.widget.WidgetSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.concurrent.TimeUnit

/** `adb logcat -s habiterall.notify` is the whole point of this being one tag. */
private const val TAG = "habiterall.notify"

/**
 * Turns each habit's `reminder_time` into an Android alarm.
 *
 * Reminder times live on the server so they follow the account to a new phone,
 * but the alarms are local: a reminder must fire when the phone is offline or
 * the server is down, which rules out any form of push.
 */
object Reminders {

    private fun alarmManager(context: Context) =
        context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    /**
     * What tells one habit's two alarms apart, and one habit's from another's.
     *
     * A PendingIntent's identity is `filterEquals` — action, DATA, type,
     * component, categories — and extras are not in it. So this string is the
     * whole of the difference between the daily alarm and a snooze: point them
     * at one uri and `setExactAndAllowWhileIdle` replaces rather than adds, and
     * "in an hour" quietly becomes the habit's new daily time.
     *
     * Pure, and public, so a test can hold the two apart without a Context.
     * That matters more than it looks: every wrong version of this compiles,
     * runs, and is invisible until the day after somebody presses snooze.
     */
    fun alarmUri(habitId: Long, snoozed: Boolean): String =
        if (snoozed) "habiterall://snooze/$habitId" else "habiterall://remind/$habitId"

    private fun pendingIntent(
        context: Context,
        habitId: Long,
        flags: Int = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    ): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            putExtra(Notifications.EXTRA_HABIT_ID, habitId)
            data = android.net.Uri.parse(alarmUri(habitId, snoozed = false))
        }
        return PendingIntent.getBroadcast(context, 0, intent, flags)
    }

    /**
     * The alarm a snooze arms — a SECOND alarm on the same habit, never the
     * daily one re-pointed.
     *
     * Two PendingIntents also mean the ordinary paths leave a snooze alone:
     * [schedule] runs on every fetch and only ever touches the daily alarm, so
     * a refresh cannot eat a snooze the user has just asked for.
     *
     * Two extras ride along, and the second is not decoration.
     * [Notifications.EXTRA_SNOOZED] tells the receiver not to arm tomorrow's
     * from this firing, and [Notifications.EXTRA_DATE] carries **the day the
     * reminder was about**, because the rule this feature exists for cannot be
     * enforced at arm time alone: the alarm may be inexact — on API 31-32 for a
     * user who has revoked "Alarms & reminders", since `USE_EXACT_ALARM` covers
     * 33+ unconditionally and nothing below 31 needs a permission — and an
     * inexact alarm set for 23:52 can be delivered at 00:03, after which
     * `LocalDate.now()` names a day the reminder was never about. The worker
     * checks it against its own today; see [stillAboutToday]. Above 32 that
     * check is belt and braces and stays anyway: it costs one string in an
     * extra, and an exact alarm is a promise about when the system WAKES, not
     * about how long the work behind it then takes.
     *
     * @param date null when CANCELLING, where the extras are irrelevant:
     *   `filterEquals` ignores them, so the uri alone finds the live one.
     */
    private fun snoozePendingIntent(
        context: Context,
        habitId: Long,
        date: String?,
        flags: Int,
    ): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            putExtra(Notifications.EXTRA_HABIT_ID, habitId)
            putExtra(Notifications.EXTRA_SNOOZED, true)
            if (date != null) putExtra(Notifications.EXTRA_DATE, date)
            data = android.net.Uri.parse(alarmUri(habitId, snoozed = true))
        }
        return PendingIntent.getBroadcast(context, 0, intent, flags)
    }

    /**
     * How long "later" is.
     *
     * One duration, in code rather than in the account's settings. A setting
     * would have to exist in `SETTING_VALUES`, carry a default every client
     * mirrors, and be argued about; a single "in an hour" answers the situation
     * the button exists for — the reminder is right and the moment is wrong.
     * A submenu of 15m / 1h / this evening is the usual expansion and needs
     * nothing here but more of the same.
     */
    const val SNOOZE_MINUTES = 60L

    /**
     * Next occurrence of [time] in the phone's own zone, in epoch millis.
     * Local time, not UTC: "remind me at 08:00" means eight in the morning
     * wherever you are, and must survive a flight and a DST boundary.
     */
    fun nextOccurrence(time: LocalTime, now: java.time.ZonedDateTime): Long {
        // Pick the DATE on the local calendar, then resolve to the zone once.
        //
        // `now.with(time).plusDays(1)` looks equivalent and is not: `with`
        // resolves against the zone straight away, so on a spring-forward day
        // a time inside the missing hour is pushed to 03:30 — and `plusDays`
        // then preserves that shifted local time, firing the NEXT day at 03:30
        // too. The reminder only righted itself on day three.
        val wanted = time.withSecond(0).withNano(0)
        var date = now.toLocalDate()

        // Resolve on the local date first; the zone decides what that instant
        // is. On a gap day java.time shifts forward (unavoidable and correct);
        // the point is that tomorrow is computed from the DATE, not from the
        // shifted result.
        var next = java.time.ZonedDateTime.of(date, wanted, now.zone)
        if (!next.isAfter(now)) {
            date = date.plusDays(1)
            next = java.time.ZonedDateTime.of(date, wanted, now.zone)
        }
        return next.toInstant().toEpochMilli()
    }

    private fun parseTime(value: String): LocalTime? =
        runCatching { LocalTime.parse(value) }.getOrNull()

    /**
     * Whether this habit should hold an alarm on this phone.
     *
     * [androidEnabled] is the account's `notifyChannels` setting: reminders can
     * be sent to a Discord channel by the server instead of, or as well as,
     * here. Switching this destination off has to stop the alarms — nothing
     * else can, since the server never sends push and does not know about them.
     */
    fun wantsAlarm(habit: Habit, androidEnabled: Boolean): Boolean =
        androidEnabled && !habit.archived && parseTime(habit.reminderTime) != null

    /**
     * Whether this habit still needs its reminder for [date].
     *
     * The same rule the server applies — `answeredIds` in shared/src/notify.js —
     * and it has to be, or the two destinations disagree about the same day and
     * whichever one stays quiet reads as broken. An answer is a COMPLETION or an
     * explicit SKIP; anything else still deserves the nudge.
     *
     * This used to ask only whether a row existed for the day, which was a third
     * rule neither side had. Six of eight glasses, or a "no" that a note keeps
     * alive, silenced the phone for the rest of the day while Discord went on
     * asking — and an explicitly skipped day was the reverse, silent here and
     * nagged there.
     *
     * A skip reaches this two ways, exactly as `Habit.isSkipped` documents: in
     * `status`, where it lives now, and as a bare 3 for a yes/no habit in an
     * imported history. For a measurable habit 3 is an amount.
     */
    fun needsReminder(habit: Habit, entries: List<Entry>, date: String): Boolean {
        val entry = entries.firstOrNull { it.date == date } ?: return true
        val skipped = entry.status == "skip" ||
            (!habit.isNumerical && entry.value == Sentinels.SKIP)
        // `isMet` is tri-state: false is a real miss, null is "not applicable",
        // and only the miss is worth a notification.
        return habit.isMet(entry.value, skipped) == false
    }

    fun schedule(context: Context, habit: Habit, androidEnabled: Boolean) {
        // The null check is stated again here rather than left to `wantsAlarm`
        // so `time` smart-casts below; the two cannot disagree.
        val time = parseTime(habit.reminderTime)
        if (time == null || !wantsAlarm(habit, androidEnabled)) {
            cancel(context, habit.id)
            return
        }

        val at = nextOccurrence(time, java.time.ZonedDateTime.now(ZoneId.systemDefault()))
        // Non-null: this call creates.
        setAlarm(context, at, pendingIntent(context, habit.id)!!)
    }

    /**
     * Set one alarm, as punctually as this install is allowed to.
     *
     * Public because the home-screen widget's midnight redraw wants the same
     * answer and the same fallback: an inexact alarm 23 hours out is given a
     * window of an HOUR, which on the one alarm whose whole point is a date
     * boundary means the widget can show yesterday until 01:00. The permission
     * is already declared and already asked about here; a second, quieter copy
     * of the exact/inexact choice is how the two would drift.
     */
    fun setAlarm(context: Context, at: Long, intent: PendingIntent) {
        val manager = alarmManager(context)
        // Which permission answers this depends on the version, and the
        // manifest declares both. From 33 up it is `USE_EXACT_ALARM`, which is
        // protection level `normal` — granted at install and not revocable —
        // so this is true there with nobody asked. On 31-32 it is
        // `SCHEDULE_EXACT_ALARM`, granted by default but revocable under
        // "Alarms & reminders", and that is the one range where the fallback
        // below is reachable. Under 31 no permission exists to revoke. Falling
        // back to an inexact alarm keeps reminders working, just less
        // punctually — better than silently dropping them. The read happens on
        // every arm, so a grant or a revocation needs no migration.
        //
        // This is deliberately SOFT, not Loop's answer: `IntentScheduler` there
        // logs "No permission to schedule exact alarms", answers
        // `SchedulerResult.IGNORED` and schedules nothing at all. That is
        // rejected here — on 31-32 the user affected is already receiving
        // late-but-real reminders, and refusing would convert a punctuality bug
        // into silence. So the `else` below still arms, and now only stops
        // being quiet about it.
        val canBeExact = Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()
        if (canBeExact) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        } else {
            Log.w(TAG, "exact alarms not permitted; arming inexactly for $at")
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        }
    }

    /**
     * Whether an alarm armed right now would be INEXACT for a reason the user
     * can undo — a narrower question than `!canScheduleExactAlarms()`, which is
     * also true below 31 (no permission exists to ask about) and would be true
     * on every phone from 33 up with nothing anybody can do about it.
     *
     * The upper bound is the load-bearing half: from 33 the app holds
     * `USE_EXACT_ALARM`, protection level `normal`, granted at install and never
     * revocable, so there is no toggle to have turned off — a line saying
     * otherwise would be false on every current phone, and false in the
     * direction nobody notices, since nothing on 33+ is ever late to disprove
     * it. Below 31 there is no permission to have revoked either, which is the
     * lower bound.
     *
     * Read at DRAW time, same as [setAlarm]'s own check, and nothing here
     * caches it: a grant or a revocation made in Android's own settings shows
     * up with no migration and nothing to invalidate.
     *
     * **Do not hoist this call into a `remember { }` or a `LaunchedEffect(Unit)`.**
     * It is an argument expression at `ManageScreen`'s call site, so it is
     * asked again on every recomposition — and `account` being `mutableStateOf`
     * means a patch or the list's own fetch recomposes that screen, which is
     * how a toggle flipped while Settings was open still corrects itself
     * without being closed. Remembering it would freeze the one answer that
     * has to be able to change underneath the screen.
     *
     * What is genuinely missing is an `ON_RESUME` re-read: come back from
     * Android's own settings having flipped the toggle and touch nothing else,
     * and the old answer stands until something recomposes or Settings is
     * closed and reopened. `androidRemindersSupported` on the line above has
     * carried exactly the same gap since it was written.
     */
    fun exactAlarmsRevoked(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 31) return false
        if (Build.VERSION.SDK_INT > 32) return false
        return !alarmManager(context).canScheduleExactAlarms()
    }

    /**
     * When a snooze on a reminder about [date] should fire, or null if there is
     * no room for one left in that day.
     *
     * Two rules, and both are about the DAY rather than about the hour.
     *
     * A snooze is a duration of real time — `plusMinutes` on a ZonedDateTime
     * moves the instant, not the wall clock — so an hour is an hour whatever
     * the clocks do that night. That is the opposite of [nextOccurrence], which
     * is a wall-clock promise, and the two differ for exactly one night a year
     * in each direction.
     *
     * And the target must land on **the day the reminder is about** — not
     * merely on the day of the press, which is the same question only until the
     * moment it matters. A notification is not removed by pressing an action
     * and has no timeout, so yesterday's can be sitting in the shade at 00:30;
     * asking "does an hour fit inside today?" happily armed one, and the
     * re-post — which reads `LocalDate.now()` — then asked about a day nobody
     * had lived while the day it was about left the shade unanswered. Yes / No
     * / Skip on that same notification write to the day it names, so snooze was
     * the one action that silently changed the subject.
     *
     * Refusing is not a silent loss: the daily alarm is untouched and asks
     * again at its own time, and the notification stays in the shade with its
     * answers still correct for the day it names.
     */
    fun snoozeUntil(now: java.time.ZonedDateTime, date: String): java.time.ZonedDateTime? {
        val at = now.plusMinutes(SNOOZE_MINUTES)
        return if (at.toLocalDate().toString() == date) at else null
    }

    /**
     * Whether a delivery that names a day may still be posted on [today].
     *
     * The second half of the rule above, and it exists because arming is not
     * the last chance to be wrong. `setAlarm` falls back to
     * `setAndAllowWhileIdle` when exact alarms are not permitted — API 31-32
     * with "Alarms & reminders" revoked, `USE_EXACT_ALARM` covering 33+
     * unconditionally — and an inexact alarm is loose by minutes: armed at
     * 22:52 for 23:52, delivered at 00:03. The press was legal and the delivery
     * is late, so the check has to happen where `today` is known, at the point
     * of posting. On 33+ it is belt and braces rather than dead, and cheap
     * enough to keep: an exact alarm bounds the WAKE, not the fetch and the
     * notification build that follow it.
     *
     * [about] is null for the DAILY alarm, which names no day and means
     * whichever day it arrives on. Only a snooze carries one.
     */
    fun stillAboutToday(about: String?, today: String): Boolean =
        about == null || about == today

    /**
     * Arm a snooze for this habit, and say whether one was armed.
     *
     * **A snooze consumes no watermark.** Nothing here writes `notify_log` —
     * that table is the SERVER's record of having sent a reminder, and an
     * Android reminder is a local alarm the server knows nothing about, so this
     * is safe by construction rather than by care. It stops being safe the
     * moment snooze is offered on a server-sent channel: the watermark is
     * written after a send, so a snoozed reminder would already be filed as
     * delivered for the day and the re-post would never go out. That is why
     * Discord is out of scope here — a snooze there is a scheduled item with
     * its own state, not a local timer.
     *
     * Pure AlarmManager, so it is safe inside a BroadcastReceiver's ten
     * seconds: no DataStore read, no coroutine, nothing to race process death.
     *
     * @param date the day the reminder being snoozed is about. It decides
     *   whether a snooze is possible at all ([snoozeUntil]) and rides on the
     *   alarm so the post can be checked against it again.
     */
    fun snooze(
        context: Context,
        habitId: Long,
        date: String,
        now: java.time.ZonedDateTime = java.time.ZonedDateTime.now(ZoneId.systemDefault()),
    ): Boolean {
        val at = snoozeUntil(now, date) ?: return false
        val intent = snoozePendingIntent(
            context,
            habitId,
            date,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ) ?: return false
        setAlarm(context, at.toInstant().toEpochMilli(), intent)
        return true
    }

    /**
     * Drop both of a habit's alarms.
     *
     * `FLAG_NO_CREATE` on BOTH: cancelling asks for the PendingIntent that
     * already exists, and `FLAG_UPDATE_CURRENT` would MAKE one in order to
     * cancel nothing. Null means there was none, which is the ordinary case for
     * the snooze. The daily one said this and did the other thing for a while,
     * which is a comment describing its own counter-example.
     *
     * This is the only place the app drops a pending snooze, and it is
     * deliberately not the only way one is lost: a reboot, a force-stop or an
     * OEM battery kill takes every alarm with it, and `rescheduleAll` re-arms
     * the DAILY one from the reminder cache and nothing else. The user is then
     * told nothing. That is the accepted trade — persisting a snooze means
     * storing exactly the state this feature exists to avoid, for a nudge that
     * would arrive after the interruption it was deferring — and the daily
     * alarm still asks at its own time.
     */
    fun cancel(context: Context, habitId: Long) {
        val manager = alarmManager(context)
        val noCreate = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
        pendingIntent(context, habitId, noCreate)?.let { manager.cancel(it) }
        // Or a habit archived, deleted or switched away from this device keeps
        // a snooze that fires once more with nothing behind it.
        snoozePendingIntent(context, habitId, date = null, flags = noCreate)
            ?.let { manager.cancel(it) }
    }

    /**
     * Re-arms one habit's alarm after it fired.
     *
     * `onDone` exists for the same reason it does on [rescheduleAll], and this is
     * the call site where it matters most: an alarm is one-shot, so the work
     * being raced here is the existence of TOMORROW's. Lose that race and the
     * habit goes quiet until the app is next cold-started or the phone reboots —
     * which is exactly what "reminders are unreliable" looks like from outside.
     */
    fun rescheduleOne(context: Context, habitId: Long, onDone: (() -> Unit)? = null) {
        armFromCache(context, habitId, onDone)
        enqueueSync(context, habitId)
    }

    /**
     * Arm from habits that have just been fetched, and mirror them for the next
     * cold boot.
     *
     * This is how a reminder time set in a BROWSER reaches the phone. Nothing
     * else on the refresh path touches an alarm: the list is drawn straight from
     * the response, so the new time appeared while the alarm was still the old
     * one — or absent — and only a cold process start corrected it. Since
     * Android usually keeps the process alive, closing and reopening the app was
     * not enough, which made the whole thing look intermittent rather than
     * missing.
     *
     * The mirror is rewritten before arming, so a cold boot with no network arms
     * the times this fetch saw rather than the ones before it. Habits that have
     * dropped out of the list since — deleted, or archived — have their alarms
     * cancelled: `schedule` only ever cancels for a habit it is handed.
     *
     * `NonCancellable`, deliberately: the caller is a fetch effect that restarts
     * whenever the visible window grows, and a half-armed schedule is the bug
     * being fixed here. It is a DataStore write and a handful of binder calls.
     */
    suspend fun armFrom(context: Context, habits: List<Habit>) {
        val app = context.applicationContext
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching {
                val settings = Settings(app)
                val enabled = settings.cachedAndroidReminders()
                val stale = settings.cachedReminders().map { it.id }.toSet() -
                    habits.map { it.id }.toSet()

                settings.cacheReminders(habits)
                Notifications.ensureChannel(app)
                habits.forEach { schedule(app, it, enabled) }
                stale.forEach { cancel(app, it) }
            }
        }
    }

    /**
     * Re-arms every habit's alarm — after a reboot, or a habit list change.
     *
     * `onDone` lets a BroadcastReceiver hold its process open via `goAsync`
     * until the cache has actually been read; without it the reschedule races
     * process death on exactly the occasion that matters most, a boot that
     * has just wiped every pending alarm.
     */
    fun rescheduleAll(context: Context, onDone: (() -> Unit)? = null) {
        armFromCache(context, null, onDone)
        enqueueSync(context, null)
    }

    /**
     * Arm alarms from the local cache, immediately and without any network.
     *
     * This is the path that actually keeps reminders working. `enqueueSync`
     * below only *refreshes* the cache; if it were the only path — as it was
     * — then a phone rebooted in airplane mode would arm nothing at all,
     * because its worker is constrained to `NetworkType.CONNECTED` and simply
     * waits. Reminders would stay silently dead until connectivity returned,
     * which is the one failure this app cannot have.
     *
     * Runs on the IO dispatcher against DataStore; callers are receivers with
     * a short window, so it must not block them.
     */
    private fun armFromCache(context: Context, habitId: Long?, onDone: (() -> Unit)? = null) {
        val app = context.applicationContext
        // A standalone scope, not the caller's: a BroadcastReceiver's lifetime
        // ends the moment onReceive returns.
        CoroutineScope(Dispatchers.IO).launch {
            try {
                runCatching {
                    val settings = Settings(app)
                    // The cached answer, not an assumption: a phone the account
                    // has switched off as a destination must not re-arm every
                    // alarm on each reboot while it waits for connectivity.
                    val enabled = settings.cachedAndroidReminders()
                    val cached = settings.cachedReminders()
                    Notifications.ensureChannel(app)
                    cached.filter { habitId == null || it.id == habitId }
                        // `schedule` cancels when it is not wanted, so a
                        // destination that has just been switched off clears the
                        // alarms it already holds rather than merely stopping
                        // new ones.
                        .forEach { schedule(app, it, enabled) }
                }
            } finally {
                onDone?.invoke()
            }
        }
    }

    /**
     * A slow heartbeat that re-arms everything, so a broken chain heals itself.
     *
     * Every other path here is an event: a launch, a boot, a reminder firing, a
     * fetch. Each one hands off to the next, and a single dropped link — a
     * process killed mid-reschedule, an alarm lost to a force-stop, an OEM
     * battery manager — leaves the habit silent indefinitely, with nothing
     * scheduled to notice. A periodic worker cannot make alarms punctual, but it
     * bounds how long a broken schedule can stay broken.
     *
     * `KEEP`, so relaunching does not restart the period and push the next run
     * away; six hours because the worker's only job is to correct drift, and
     * WorkManager will batch it with whatever else is waiting.
     */
    fun enqueuePeriodicSync(context: Context) {
        val request = PeriodicWorkRequestBuilder<ScheduleWorker>(6, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "schedule:heartbeat",
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    private fun enqueueSync(context: Context, habitId: Long?) {
        val data = Data.Builder()
        if (habitId != null) data.putLong(Notifications.EXTRA_HABIT_ID, habitId)

        val request = OneTimeWorkRequestBuilder<ScheduleWorker>()
            .setInputData(data.build())
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            if (habitId != null) "schedule:$habitId" else "schedule:all",
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    /**
     * Refreshes the local cache from the server and re-arms from it.
     *
     * Network-constrained, and that is now acceptable: `armFromCache` has
     * already scheduled from whatever was last known, so this only corrects
     * the schedule after a change made elsewhere. Losing it costs accuracy,
     * not the reminder itself.
     */
    class ScheduleWorker(
        appContext: Context,
        params: WorkerParameters,
    ) : CoroutineWorker(appContext, params) {

        override suspend fun doWork(): Result {
            val settings = Settings(applicationContext)
            val api = settings.api() ?: return Result.success()
            // See Outbox.SyncWorker: `hasKeyWithValueOfType` is not reified.
            val only = if (inputData.keyValueMap.containsKey(Notifications.EXTRA_HABIT_ID)) {
                inputData.getLong(Notifications.EXTRA_HABIT_ID, -1)
            } else {
                null
            }

            val habits = try {
                api.habits()
            } catch (e: Exception) {
                return Result.retry()
            }

            // Read before the cache is rewritten: a habit that has dropped out
            // of the list — deleted, or archived — still holds an alarm, and
            // `schedule` can only cancel for a habit it is handed. Without this
            // the alarm survives and wakes the phone every day to post nothing.
            val stale = runCatching {
                settings.cachedReminders().map { it.id }.toSet() - habits.map { it.id }.toSet()
            }.getOrDefault(emptySet())

            // Refresh the offline cache on every successful fetch. This is
            // what makes the next cold boot able to arm alarms with no
            // network — the whole point of the cache.
            runCatching { settings.cacheReminders(habits) }

            // Whether this device is still a destination for reminders. A
            // failed settings fetch falls back to the cached answer rather than
            // to "enabled": one flaky request must not resurrect alarms the
            // user turned off.
            val enabled = try {
                // A property on the response, not a call — and `cachedAndroidReminders`
                // below is the suspend read of the mirror. Two similarly-named
                // things, so they are spelled differently on purpose.
                val fresh = api.settings()
                runCatching { settings.cacheAndroidReminders(fresh.androidRemindersEnabled) }
                // The shade's Skip action comes from the same response, and this is
                // the OTHER path that can learn a new value for it: the six-hourly
                // sync runs whether or not anyone opens the app, so a `skipDays`
                // switched off in a browser reached the alarms and not the actions
                // beside them. Whichever of the two paths ran last decided, which
                // is the drift this whole mirror exists to prevent.
                runCatching { settings.cacheSkipDays(fresh.skipDaysEnabled) }
                // And the other half of what `Grid.nextState` reads, for the
                // home-screen widget — which cycles a day with no network at
                // all and must walk the same four states the app's grid does.
                runCatching { settings.cacheQuestionMarks(fresh.questionMarksEnabled) }
                fresh.androidRemindersEnabled
            } catch (e: Exception) {
                settings.cachedAndroidReminders()
            }

            Notifications.ensureChannel(applicationContext)

            if (only != null) {
                // A habit deleted server-side would otherwise keep its alarm
                // and re-fire every day forever: an absent habit must cancel,
                // not just skip. `schedule` already cancels for archived or
                // reminder-less habits.
                val habit = habits.firstOrNull { it.id == only }
                if (habit == null) cancel(applicationContext, only)
                else schedule(applicationContext, habit, enabled)
            } else {
                habits.forEach { schedule(applicationContext, it, enabled) }
                stale.forEach { cancel(applicationContext, it) }
            }

            // The home screen has the same problem the alarms do — nothing
            // pushes to it and it cannot poll — so the heartbeat that exists to
            // heal a broken chain of events heals that one too. It costs one
            // request, and only on a phone that has a widget: `refreshFromServer`
            // reads the overview, because a widget is about the DAY and
            // `api.habits()` above does not carry one.
            runCatching { WidgetSync.refreshFromServer(applicationContext, api) }
            return Result.success()
        }
    }
}
