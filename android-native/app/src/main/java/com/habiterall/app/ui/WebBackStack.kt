package com.habiterall.app.ui

/**
 * Which Back presses belong to the page, and which one closes the screen.
 *
 * This used to need no thought: the WebView was built on the tap that opened it
 * and destroyed on the way out, so a deep link was the FIRST entry in a brand
 * new back-forward list and `canGoBack()` alone was the whole rule. CLAUDE.md
 * records the consequence as deliberate — WebView skips an entry pushed without
 * a user gesture, so Back closed the screen and returned you to the native list
 * you tapped from.
 *
 * A WebView that outlives the screen breaks exactly that. It has already loaded
 * something by the time you tap, so `routes.go()`'s push lands on top of a
 * non-empty list, `canGoBack()` is true, and Back walks the PAGE to the web
 * dashboard instead of closing the screen. The reused WebView is the whole point
 * of keeping it alive, and it would have silently changed what Back means.
 *
 * So the rule is a floor rather than a flag: remember how deep the list was when
 * this screen was opened, walk the page while we are above that, and close when
 * we reach it. Pages the user navigated to THEMSELVES — tapping through from the
 * web dashboard — sit above the floor and still get their Back presses.
 *
 * Pure, so the arithmetic is pinned by `WebBackStackTest` rather than reasoned
 * about on a device, in the style of [ScrollRestore].
 */
object WebBackStack {

    /**
     * The back-forward index this screen may not walk past.
     *
     * @param indexBeforeLoad `WebBackForwardList.currentIndex` read immediately
     *   before the navigation — -1 when nothing has ever loaded.
     * @param navigated whether a load was actually started. Reopening the habit
     *   already on screen does not navigate, so it must not raise the floor;
     *   raising it there would leave a screen Back could not close.
     */
    fun floorAfterShow(indexBeforeLoad: Int, navigated: Boolean): Int {
        val base = if (navigated) indexBeforeLoad + 1 else indexBeforeLoad
        // A load that has not committed yet leaves the index at -1, and the
        // target then commits AT 0 rather than after it — it replaces the
        // uncommitted entry instead of stacking on it. Clamping is what makes
        // "tapped a habit before the warm-up finished" land on the same floor as
        // every other first open.
        return base.coerceAtLeast(0)
    }

    /**
     * Whether Back should walk the page rather than close the screen.
     *
     * `canGoBack` is asked for as well as the index because they can disagree:
     * an entry WebView declines to traverse (its own skip-a-gestureless-push
     * rule) still counts in the list, and going back to a page that will not
     * move is a Back press that does nothing.
     */
    fun shouldWalkHistory(currentIndex: Int, floor: Int, canGoBack: Boolean): Boolean =
        canGoBack && currentIndex > floor
}
