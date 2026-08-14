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

    /** What a day shows, for a yes/no habit. */
    enum class DayState { UNSET, DONE, SKIPPED }

    /**
     * unset → done → skipped → unset.
     *
     * The same cycle as the web grid's `onCheckClick`, deliberately: the two
     * clients show the same squares to the same person, and a tap that means
     * something different depending on which one they opened is the kind of
     * difference nobody reads a changelog to discover.
     */
    fun nextState(current: DayState): DayState = when (current) {
        DayState.UNSET -> DayState.DONE
        DayState.DONE -> DayState.SKIPPED
        DayState.SKIPPED -> DayState.UNSET
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
