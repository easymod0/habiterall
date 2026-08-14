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
 * **The floor cannot be counted for a load of the shell**, and that is the one
 * thing arithmetic here cannot fix. A same-document open lands on exactly one
 * entry, so "one above where we were" is the answer. A cross-document open lands
 * on one and then the page adds a SECOND from inside itself: `app.js` boots with
 * `routes.go(LIST)` (a replace) and then `detail.open()` pushes `#/habit/42` —
 * after the load committed, so nothing measured before it can see it. Counting
 * two instead would be this module hard-coding how many entries a page happens
 * to push. [WebHost] truncates the list on commit instead, which puts the
 * document at 0 and hands the question back to `canGoBack()` — the shape that
 * was already correct when the WebView was built per open.
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
     * @param pushedOneEntry whether this open added exactly one entry and it is
     *   the one to stop at — a same-document open, and nothing else. Reopening
     *   the habit already on screen does not navigate, so it must not raise the
     *   floor; raising it there would leave a screen Back could not close. A
     *   cross-document open is not one either: see the note above, and
     *   [isSameDocument].
     */
    fun floorAfterShow(indexBeforeLoad: Int, pushedOneEntry: Boolean): Int {
        val base = if (pushedOneEntry) indexBeforeLoad + 1 else indexBeforeLoad
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

    /**
     * Whether loading [target] over [current] stays inside the same document.
     *
     * This is what separates the two kinds of open, and it is asked rather than
     * assumed because the answer decides whether the floor can be counted at
     * all. Chromium's rule: a navigation is same-document when the URLs are
     * identical up to the '#' AND the new one actually has a fragment. Habit to
     * habit therefore costs nothing — `#/habit/42` to `#/habit/43` is a parsed
     * document being told to look somewhere else — while the Statistics button,
     * which aims at the bare server URL, is a full load. DROPPING a fragment is
     * cross-document: there is no fragment to scroll to, so the document is
     * fetched again.
     *
     * @param current `WebView.url`, or null before anything has loaded.
     */
    fun isSameDocument(current: String?, target: String): Boolean {
        if (current == null) return false
        val hash = target.indexOf('#')
        // A trailing bare '#' is an empty fragment, which Chromium does treat as
        // same-document — but no caller here builds one (`ServerUrl.habitRoute`
        // always names a route), so it is refused rather than reasoned about.
        if (hash < 0 || hash == target.length - 1) return false
        return current.substringBefore('#') == target.substring(0, hash)
    }

    /** `#/habit/<id>`, mirroring `HABIT_RE` in shared/public/ui/routes.js. */
    private val HABIT_FRAGMENT = Regex("""/habit/\d+""")

    /**
     * Whether [url] is showing a habit rather than the dashboard.
     *
     * A native mirror of `routes.js`'s route matching, kept for the same reason
     * [ServerUrl.habitRoute] mirrors `hashFor`: this side writes the fragment, so
     * it has to be able to read one.
     */
    fun isHabitRoute(url: String?): Boolean {
        val hash = url?.indexOf('#') ?: -1
        if (hash < 0) return false
        return HABIT_FRAGMENT.matches(url!!.substring(hash + 1))
    }

    /**
     * Whether a same-document open should REPLACE the entry showing rather than
     * stack a new one on it.
     *
     * Swapping one habit for another has to replace, and the reason is the web
     * UI's own Back button rather than tidiness. `routes.go(LIST)` reaches the
     * dashboard by UNWINDING the entry it pushed (`history.back()` — see the note
     * in routes.js, it is deliberate and it is what stops Back walking through a
     * duplicate per habit). That assumes the entry underneath a habit is the
     * dashboard. Pushing one habit onto another breaks the assumption silently:
     * every native tap added an entry, so the page's "← Back" walked to the habit
     * viewed BEFORE this one, and the list grew for as long as the app was open.
     * Measured, not deduced — Gym, then Meditate, then "← Back" showed Gym.
     *
     * Replacing the DASHBOARD entry would be the same mistake mirrored: the page
     * would have nothing left to unwind to. So it is asked of [current], not of
     * the target — habit over habit replaces, habit over dashboard pushes, and
     * either way the list is exactly the dashboard with one habit above it.
     */
    fun replacesEntry(current: String?, target: String): Boolean =
        isSameDocument(current, target) && isHabitRoute(current)
}
