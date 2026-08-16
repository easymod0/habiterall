package com.habiterall.app.data

import java.time.LocalDate

/**
 * The day grid's arithmetic, kept away from Compose so it can be tested.
 *
 * Every rule here was a decision rather than an obvious answer, and two of
 * them are only visible on a phone in someone's hand: which direction the days
 * run, and what happens to the scroll position when older days arrive.
 */
object Grid {

    /** Day columns asked for on first paint. */
    const val INITIAL_DAYS = 30

    /** Added each time the far edge of the loaded history comes into view. */
    const val PAGE_DAYS = 30

    /**
     * The most days that will ever be loaded.
     *
     * `/api/overview` clamps `days` to 365 itself, so asking for more returns
     * fewer than requested and the grid would keep asking forever, one wasted
     * request per scroll. The cap belongs on this side too.
     */
    const val MAX_DAYS = 365

    /**
     * What a day shows, for a yes/no habit.
     *
     * UNKNOWN is the absence of a row and NO is a row holding 0. They look
     * identical unless question marks are on, but they are not the same claim —
     * see the note in shared/src/constants.js.
     */
    enum class DayState { UNKNOWN, DONE, SKIPPED, NO }

    /**
     * The cycle a tap follows, mirroring `nextDayState` in
     * shared/public/ui/toggle.js — which in turn mirrors Loop's own
     * `Entry.nextToggleValue`. The two clients show the same squares to the same
     * person, and a tap that means something different depending on which one
     * they opened is the kind of difference nobody reads a changelog to
     * discover. `GridTest` and `test/toggle.test.js` are pinned to the same
     * examples for exactly that reason.
     *
     * Note that with [questionMarks] off there is no way back to UNKNOWN from
     * the grid: a touched day is done or not-done from then on, and clearing it
     * means the day editor. That is Loop's behaviour, and it is right — with the
     * setting off the two states paint identically, so a step between them would
     * be a tap that appears to do nothing.
     */
    /**
     * Which state a day is in, from what the API reported for it.
     *
     * [value] must be what the entries map actually HELD — null for a day with
     * no row. Defaulting a missing day to 0.0 here would report every day nobody
     * has answered as an answered "no" and start the cycle in the wrong place.
     * Mirrors `dayStateOf` in shared/public/ui/toggle.js.
     */
    fun dayStateOf(value: Double?, isSkip: Boolean, done: Boolean): DayState = when {
        isSkip -> DayState.SKIPPED
        value == null -> DayState.UNKNOWN
        done -> DayState.DONE
        else -> DayState.NO
    }

    /**
     * What a tap records, for this habit and this state.
     *
     * The cycle above is untouched by a habit shown as something to avoid, and
     * that is the point: it walks the same four states in the same order — a
     * clean day is DONE, a slip is NO — so the mirror everything else in this
     * object exists to protect did not have to learn anything. What differs is
     * only the ENCODING:
     *
     *   state   normal habit        avoided habit
     *   DONE    YES                 0            "none today", which is the goal
     *   NO      UNSET (0)           target + 1   the smallest amount that fails
     *
     * `target + 1` rather than a fixed 1, so a limit of two coffees records
     * three — the least the app can claim on the user's behalf. The day editor
     * still takes the exact number.
     *
     * Mirrors `valueForState` in shared/public/ui/toggle.js, and it is a mirror
     * for the reason the cycle beside it is: this runs when a tap is made with
     * no network, and two clients encoding one tap differently is worse than
     * either encoding being wrong.
     *
     * SKIPPED and UNKNOWN are absent because neither is a value — a skip is the
     * status column and an unknown day is the absence of a row.
     */
    fun valueForState(habit: Habit, state: DayState): Double = when {
        // A skip is the status column and never a value — `record` takes a
        // `skip` flag for it, and every caller routes SKIPPED there before
        // reaching this. The web mirror briefly answered the SKIP sentinel
        // here, which stored a measurable habit's skip as three of the thing;
        // it throws now, and so does this. Loud rather than silent, because a
        // caller that gets here has a bug the grid cannot show.
        state == DayState.SKIPPED ->
            error("a skip is the status column, not a value")
        habit.isAvoided ->
            if (state == DayState.DONE) Sentinels.UNSET else habit.targetValue + 1
        else ->
            if (state == DayState.DONE) Sentinels.YES else Sentinels.UNSET
    }

    fun nextState(
        current: DayState,
        skipDays: Boolean = false,
        questionMarks: Boolean = false,
    ): DayState = when (current) {
        DayState.DONE -> if (skipDays) DayState.SKIPPED else DayState.NO
        // Straight to NO even when skips have since been switched off: the day
        // is already a skip, and a tap has to take it somewhere.
        DayState.SKIPPED -> DayState.NO
        DayState.NO -> if (questionMarks) DayState.UNKNOWN else DayState.DONE
        DayState.UNKNOWN -> DayState.DONE
    }

    /**
     * The dates a window covers, in the order they are drawn.
     *
     * Always ends at [today] — there is no such thing as a future column, so
     * nothing here has to guard against writing to one. The server refuses it
     * anyway (`assertNotFuture`), but a cell that cannot be tapped is a better
     * answer than an error.
     */
    fun dates(today: LocalDate, days: Int, newestLeft: Boolean): List<String> {
        val newestFirst = (0 until days).map { today.minusDays(it.toLong()).toString() }
        return if (newestLeft) newestFirst else newestFirst.reversed()
    }

    /**
     * Whether the far edge of the loaded history is close enough to load more.
     *
     * "Far edge" depends on the day order, and this is the whole reason the
     * two directions are not symmetric: with the newest day on the left, older
     * days are at the END of the scroll, so more is needed as the scroll
     * approaches its maximum. With the newest on the right they are at the
     * START, and the trigger is approaching zero instead.
     *
     * @param scroll     current horizontal offset, in pixels
     * @param maxScroll  the largest that offset can be
     * @param threshold  how close to the edge counts as "close", in pixels
     */
    fun needsMore(
        scroll: Int,
        maxScroll: Int,
        loadedDays: Int,
        newestLeft: Boolean,
        threshold: Int,
    ): Boolean {
        if (loadedDays >= MAX_DAYS) return false
        // Nothing has been laid out yet, or it all fits: either way there is
        // no edge to be near, and treating 0 as "at the start" would fire this
        // on the first frame and page to the cap without anyone scrolling.
        if (maxScroll <= 0) return false

        return if (newestLeft) scroll >= maxScroll - threshold else scroll <= threshold
    }

    /**
     * Where the scroll must land once [addedDays] more days have been drawn.
     *
     * With the newest day on the left, older days are appended past the right
     * edge and nothing under the finger moves — the offset is already right.
     * With the newest on the right they are *prepended*, so every column
     * shifts by its own width and the day being looked at slides away unless
     * the offset moves with it. Without this the grid jumps a month sideways
     * at the exact moment it loads more, which reads as losing your place.
     */
    fun scrollAfterGrowth(
        scroll: Int,
        addedDays: Int,
        cellWidthPx: Int,
        newestLeft: Boolean,
    ): Int = if (newestLeft) scroll else scroll + addedDays * cellWidthPx
}
