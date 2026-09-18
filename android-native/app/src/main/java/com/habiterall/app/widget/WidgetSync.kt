package com.habiterall.app.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import com.habiterall.app.data.Api
import com.habiterall.app.data.Habit
import com.habiterall.app.data.Outbox
import com.habiterall.app.data.Settings
import com.habiterall.app.data.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.time.LocalDate

/**
 * Keeps the home screen in step with the account.
 *
 * A widget cannot poll and nothing pushes to it, so every path that learns
 * something has to hand it on — the rule `Reminders.armFrom` was written for,
 * arriving at a second surface. There are four ways in and they are deliberately
 * the ones that already exist: the list's own fetch ([refreshFrom]), the
 * six-hourly heartbeat that already re-arms alarms ([refreshFromServer], called
 * from `Reminders.ScheduleWorker`), an answer given elsewhere on this phone
 * ([noteAnswer]), and the widget's own tap.
 */
object WidgetSync {

    /**
     * Update every widget from habits that have just been fetched.
     *
     * `NonCancellable`, for the reason `Reminders.armFrom` is: the caller is a
     * fetch effect that restarts whenever the visible window grows, and half a
     * home screen updated is worse than none of it. It is a DataStore write and
     * a handful of binder calls.
     *
     * Two different jobs, and they are not the same job with a different
     * cardinality. A single-habit widget's record is REFRESHED in place, and an
     * unchanged one is dropped so a refresh that decided nothing writes
     * nothing — which is exactly why those records cannot go through
     * [Settings.putWidgetSet]: that says "these are the widget's records now",
     * and the dropped-unchanged filter above it would purge every untouched row
     * of every widget in the store. An overview widget's set is RECONCILED
     * instead — membership, order and rank are all decided by the served list,
     * so the whole set is rewritten and `putWidgetSet` is the only write that
     * can express it.
     */
    suspend fun refreshFrom(context: Context, habits: List<Habit>) {
        val app = context.applicationContext
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching {
                val settings = Settings(app)
                val records = settings.cachedWidgets()
                // Which ids are overviews is the launcher's answer, not the
                // store's: an overview widget placed but never seeded holds no
                // records at all, and that is precisely the one this has to
                // reconcile rows INTO.
                val overviewIds =
                    HabitWidget.liveIds(app, AppWidgetManager.getInstance(app)).overview
                if (records.isEmpty() && overviewIds.isEmpty()) return@runCatching
                val today = LocalDate.now().toString()

                val updated = records.filterNot { it.widgetId in overviewIds }.mapNotNull { record ->
                    val habit = habits.firstOrNull { it.id == record.habitId }
                    // A tap still on its way wins over the server's answer,
                    // which is by definition older than it. This is the
                    // `pending` overlay of the list screen, asked of the outbox
                    // instead of held in memory: a widget's tap happens in a
                    // broadcast receiver that may not outlive the write, so
                    // there is nowhere in this process to hold it.
                    //
                    // A habit that has disappeared is the exception: whether
                    // its widget still accepts taps is not a question about the
                    // day, and it has to be answered even while one is queued.
                    if (habit != null &&
                        record.date == today &&
                        Outbox.isPending(app, record.habitId, today)
                    ) {
                        return@mapNotNull null
                    }
                    // Marked gone, or brought back — `Widgets.refreshedOrGone`
                    // is the rule, and it is there rather than here so a test
                    // can reach it. Unchanged records are dropped so a refresh
                    // that decided nothing writes nothing.
                    Widgets.refreshedOrGone(record, habit, today)
                        .takeIf { it != record }
                }

                settings.putWidgets(updated)
                overviewIds.forEach { widgetId ->
                    settings.putWidgetSet(
                        widgetId,
                        reconciledRows(
                            app,
                            records.filter { it.widgetId == widgetId },
                            widgetId,
                            habits,
                            today,
                        ),
                    )
                }
                HabitWidget.redraw(app)
            }
        }
    }

    /**
     * One overview widget's rows, with the in-flight answers above them kept.
     *
     * `Widgets.reconcileOverview` decides membership, order and each row's day
     * from the SERVER's reply, and that is right for everything but one case —
     * the same case the single-habit skip in [refreshFrom] exists for, reached
     * by a different road. The overview itself writes nothing, but the habit in
     * a row does get answered elsewhere on this phone: a notification's
     * buttons, its number pad, or a checkmark widget for the same habit, all of
     * which paint through `noteAnswer` and then queue. A fetch that lands while
     * that write is still in the outbox carries an answer OLDER than the tap,
     * so writing it over the row would blank a cell the user has already
     * answered — and offline it would stay blanked until the write finally
     * lands.
     *
     * So the skip applies, in the same shape and for the same reason, with one
     * narrowing the single-habit path does not need: [Outbox.isPending] is
     * asked only for a row whose refreshed day actually DISAGREES with what the
     * row already shows. A widget is at most a handful of records and a
     * question each; an overview is one per habit on the account, on every
     * fetch, and a question asked about a row that would not change is a
     * WorkManager round trip bought for nothing.
     *
     * What is NOT kept is anything else about the row. A pending write says
     * something about one day, not about whether the habit is still on the
     * account or where the account now sorts it, so `gone`, `rank` and the
     * habit's own shape all come from the reconcile regardless.
     */
    private suspend fun reconciledRows(
        context: Context,
        held: List<Widgets.Record>,
        widgetId: Int,
        habits: List<Habit>,
        today: String,
    ): List<Widgets.Record> {
        val byHabit = held.associateBy { it.habitId }
        return Widgets.reconcileOverview(held, widgetId, habits, today).map { row ->
            val prior = byHabit[row.habitId] ?: return@map row
            if (prior.date != today) return@map row
            if (prior.value == row.value && prior.skip == row.skip) return@map row
            if (!Outbox.isPending(context, row.habitId, today)) return@map row
            row.copy(value = prior.value, skip = prior.skip)
        }
    }

    /**
     * Fetch and update, for a caller that has an [Api] but no habits in hand.
     *
     * One request, and only when a widget exists — the overview rather than the
     * habit list because it carries the DAYS, which is the half a widget is
     * about.
     *
     * [Widgets.MAX_STRIP_DAYS], not `1`: this is the six-hourly heartbeat
     * (`Reminders.ScheduleWorker`) that is the stats widget's strip's own
     * refresh, and a one-day window silently yields a strip [Widgets.encodeHistory]
     * can put nothing but "unknown" in — the checkmark widget's one cell never
     * noticed because it only ever reads `today`. [refreshFrom] itself is left
     * asking nothing of its own: the list's fetch (its other caller) already
     * asks for a far larger window, and narrowing this call is enough.
     *
     * "Only when a widget exists" is TWO questions and not one — the same pair
     * [refreshFrom]'s own guard asks, for the same reason. A record in the
     * store is evidence of a widget, but an overview widget placed and never
     * seeded holds no records at all: its configuration activity can be
     * dismissed, killed, or run against a server it cannot reach, and it
     * finishes CANCELLED having written nothing. Asked of the store alone this
     * heartbeat returned before it fetched anything, so the one path that would
     * ever have filled that widget was the one path that skipped it. With
     * genuinely nothing on the home screen both sets are empty and no request
     * is made, which is what the guard is for.
     */
    suspend fun refreshFromServer(context: Context, api: Api) {
        val app = context.applicationContext
        val records = runCatching { Settings(app).cachedWidgets() }.getOrDefault(emptyList())
        val overviewIds = runCatching {
            HabitWidget.liveIds(app, AppWidgetManager.getInstance(app)).overview
        }.getOrDefault(emptySet())
        if (records.isEmpty() && overviewIds.isEmpty()) return
        val data = runCatching { api.overview(days = Widgets.MAX_STRIP_DAYS) }.getOrNull() ?: return
        refreshFrom(app, data.habits)
    }

    /**
     * A write the server refused for good, taken back off the home screen.
     *
     * The widget paints a tap before it is delivered, and `SyncWorker` drops a
     * 4xx as permanently inapplicable — so without this the cell goes on
     * claiming an answer that was never stored, until some later refresh
     * silently repaints the server's version hours afterwards. The reliable way
     * to produce one is a phone whose local date is ahead of the server's,
     * which `Outbox.awaitWrite` already records as the case that cost the list
     * screen a wrong cell.
     *
     * The day is returned to UNANSWERED rather than to what it held before,
     * because the record does not keep a previous value and inventing one would
     * be a second claim about the same day. A refresh replaces it with the
     * server's answer as soon as there is a network.
     *
     * What this does NOT do is tell the user. The shade's buttons are equally
     * silent about a refused write and there is nowhere on a 2x2 cell to say
     * it; the list screen is the surface that reports one.
     */
    suspend fun noteRefused(context: Context, habitId: Long, date: String) {
        val app = context.applicationContext
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching {
                // Read and change inside ONE `edit`: this derives new values
                // from what it read, so a tap landing between a separate read
                // and write would either be lost or lose its rollback.
                Settings(app).updateWidgets { records ->
                    records.map {
                        if (it.habitId == habitId && it.date == date) {
                            // NOT `figuresStale = true`, on purpose — but not
                            // because setting it would put the note line on
                            // screen: on every path that can reach a refusal
                            // (the shade's buttons, the number pad, a widget's
                            // own tap), the `noteAnswer`/`Widgets.answered`
                            // that preceded the write already set the flag,
                            // so `stats_figures_behind` is already showing
                            // before this ever runs, and leaving it alone
                            // changes nothing there. The one path this
                            // decision is not a no-op for is `MainActivity`'s
                            // list-screen tap, which enqueues without calling
                            // `noteAnswer` at all.
                            //
                            // A refusal never reached the server, so it moved
                            // none of the server's figures — it is neither
                            // evidence they are behind nor evidence they are
                            // current. A boolean cannot distinguish "the
                            // answer THIS refusal just rolled back" from "an
                            // earlier answer that landed and has not been
                            // re-fetched since", so the flag is left exactly
                            // as found rather than set or cleared —
                            // over-reporting staleness is the fail-safe
                            // direction, and clearing it here could erase a
                            // genuine staleness this refusal knows nothing
                            // about.
                            it.copy(value = null, skip = false)
                        } else {
                            it
                        }
                    }
                }
                HabitWidget.redraw(app)
            }
        }
    }

    /**
     * Note an answer given somewhere else on this phone — the notification's
     * buttons, or its number pad.
     *
     * Those write through the outbox and never touch the server, so without
     * this the home screen goes on showing an unanswered day until a refresh
     * arrives, which offline can be hours. Same optimistic paint the widget's
     * own tap makes, from the same two values.
     */
    suspend fun noteAnswer(
        context: Context,
        habitId: Long,
        date: String,
        value: Double?,
        skip: Boolean,
    ) {
        val app = context.applicationContext
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching {
                // One `edit` for the same reason: `answered` reads the
                // record's own date to decide whether this answer is newer.
                Settings(app).updateWidgets { records ->
                    records.map {
                        if (it.habitId == habitId) Widgets.answered(it, date, value, skip) else it
                    }
                }
                HabitWidget.redraw(app)
            }
        }
    }
}
