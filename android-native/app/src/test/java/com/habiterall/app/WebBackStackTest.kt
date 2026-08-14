package com.habiterall.app

import com.habiterall.app.ui.WebBackStack.floorAfterShow
import com.habiterall.app.ui.WebBackStack.isHabitRoute
import com.habiterall.app.ui.WebBackStack.isSameDocument
import com.habiterall.app.ui.WebBackStack.replacesEntry
import com.habiterall.app.ui.WebBackStack.shouldWalkHistory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What Back does, once the WebView outlives the screen.
 *
 * The regression this guards is silent: with a WebView built fresh per open,
 * `canGoBack()` was false on a deep link and Back closed the screen. Reusing the
 * WebView leaves earlier entries in the list, so the same press starts walking
 * the page to the web dashboard instead of returning to the native habit list —
 * the app appearing to refuse to close a screen, which is the exact symptom
 * `routes.go()` already has a note about.
 *
 * The first version of this file got the arithmetic right and the WORLD wrong,
 * which is worth knowing before adding a case. It assumed a document load leaves
 * the loaded page as the last entry in the list; the page pushes one more from
 * inside itself (`app.js` calls `routes.go(LIST)` and then `detail.open()`
 * pushes `#/habit/42`), and it does it after the load has committed, where
 * nothing measured beforehand can count it. So a floor is only ever counted for a
 * SAME-document open. A cross-document one is fenced by truncating the list on
 * commit instead, which is `WebHost.truncateOnLoad`, and its floor is 0.
 */
class WebBackStackTest {

    @Test
    fun `the page's own push is above the floor of a document load`() {
        // The case the first version of this got wrong, and the reason a floor is
        // not counted for a document load at all. WebHost truncates on commit, so
        // the document is entry 0 — and the entry app.js then pushes for its own
        // route is entry 1, which is above the floor and therefore walkable.
        // `canGoBack` is what closes the screen there, exactly as it did when the
        // WebView was built per tap.
        val floor = 0
        assertFalse(
            "Back on the first habit must return to the native list",
            shouldWalkHistory(currentIndex = 1, floor = floor, canGoBack = false),
        )
        // Counting a floor for that load would have produced 1 against an index of
        // 2, and the press would have walked the page instead of leaving.
        assertTrue(shouldWalkHistory(currentIndex = 2, floor = 1, canGoBack = true))
    }

    @Test
    fun `a document load does not move the floor before it commits`() {
        // Between the tap and the commit there is nothing new to stop at, so the
        // floor stays where it is and Back closes the screen rather than walking
        // into whatever the WebView was showing before.
        val floor = floorAfterShow(indexBeforeLoad = 3, pushedOneEntry = false)
        assertEquals(3, floor)
        assertFalse(shouldWalkHistory(currentIndex = 3, floor = floor, canGoBack = true))
    }

    @Test
    fun `habit to habit stops at the entry it pushed`() {
        // A fragment change on a document already loaded: one entry, and the page
        // pushes nothing of its own because `routes.go` finds the hash it wants
        // already in the address bar. This is the open the floor exists for.
        val floor = floorAfterShow(indexBeforeLoad = 1, pushedOneEntry = true)
        assertEquals(2, floor)
        assertFalse(shouldWalkHistory(currentIndex = 2, floor = floor, canGoBack = true))
    }

    @Test
    fun `a tap before anything has committed lands on zero`() {
        // Nothing committed yet, so the target commits AT 0 rather than after it.
        // Not reachable while warming loads about:blank first, but the clamp is
        // what stops an unclamped -1 becoming a floor a growing list walks under.
        val floor = floorAfterShow(indexBeforeLoad = -1, pushedOneEntry = true)
        assertEquals(0, floor)
        assertFalse(shouldWalkHistory(currentIndex = 0, floor = floor, canGoBack = false))
    }

    @Test
    fun `reopening the habit already loaded does not raise the floor`() {
        // Open a habit, Back to the list, open the same one again. Nothing
        // navigates, so nothing was pushed — and a floor raised here would sit
        // one above the current index forever, leaving a screen Back could not
        // close. It does need to be RE-read: the entry showing is the page's own
        // push, one above where the document load left it.
        val floor = floorAfterShow(indexBeforeLoad = 1, pushedOneEntry = false)
        assertEquals(1, floor)
        assertFalse(shouldWalkHistory(currentIndex = 1, floor = floor, canGoBack = true))
    }

    @Test
    fun `pages the user navigated to themselves keep their Back presses`() {
        // Opened a habit (floor 1), then tapped through inside the web UI.
        // Those are the user's own navigations and Back belongs to them.
        assertTrue(shouldWalkHistory(currentIndex = 3, floor = 1, canGoBack = true))
        assertTrue(shouldWalkHistory(currentIndex = 2, floor = 1, canGoBack = true))
        // Walked all the way back down to the habit we opened at: the next
        // press is the one that leaves.
        assertFalse(shouldWalkHistory(currentIndex = 1, floor = 1, canGoBack = true))
    }

    @Test
    fun `an entry WebView will not traverse is not a Back press that does nothing`() {
        // The index says there is somewhere to go and WebView disagrees — its
        // own rule about skipping an entry pushed without a user gesture. Asking
        // both is what stops a press that visibly does nothing.
        assertFalse(shouldWalkHistory(currentIndex = 5, floor = 1, canGoBack = false))
    }

    @Test
    fun `going back further than the floor is never proposed`() {
        // Not reachable through the API — the floor is only ever set at or below
        // the current index — but the comparison is what everything else here
        // rests on, so it is pinned rather than assumed.
        assertFalse(shouldWalkHistory(currentIndex = 0, floor = 2, canGoBack = true))
    }

    @Test
    fun `habit to habit is the same document`() {
        assertTrue(
            isSameDocument("http://pi:3000/#/habit/42", "http://pi:3000/#/habit/43"),
        )
        // Reopening the same one, which navigates nowhere at all.
        assertTrue(
            isSameDocument("http://pi:3000/#/habit/42", "http://pi:3000/#/habit/42"),
        )
        // The page unwound to its own list, and a habit is asked for again.
        assertTrue(isSameDocument("http://pi:3000/", "http://pi:3000/#/habit/42"))
    }

    @Test
    fun `dropping a fragment is a document load`() {
        // This is why the Statistics button reloads: it aims at the bare server
        // URL, and a navigation with no fragment has nothing to scroll to, so the
        // document is fetched again rather than told to look elsewhere.
        assertFalse(isSameDocument("http://pi:3000/#/habit/42", "http://pi:3000/"))
        assertFalse(isSameDocument("http://pi:3000/", "http://pi:3000/"))
    }

    @Test
    fun `habit over habit replaces, so the dashboard stays underneath`() {
        // The regression this pins is the web UI's own "← Back": it reaches the
        // dashboard by unwinding the entry it pushed, which only works while the
        // entry underneath a habit IS the dashboard. Pushing habit onto habit sent
        // it to the habit viewed before instead — Gym, then Meditate, then "←
        // Back" showed Gym — and grew the list for as long as the app was open.
        assertTrue(
            replacesEntry("http://pi:3000/#/habit/42", "http://pi:3000/#/habit/43"),
        )
    }

    @Test
    fun `habit over the dashboard pushes, or there is nothing to unwind to`() {
        // The mirror image of the same mistake: replacing the dashboard entry
        // would leave the page's "← Back" with nowhere to go.
        assertFalse(replacesEntry("http://pi:3000/", "http://pi:3000/#/habit/42"))
        // And a document load is never a replace, whatever the URLs say.
        assertFalse(replacesEntry("about:blank", "http://pi:3000/#/habit/42"))
        assertFalse(replacesEntry(null, "http://pi:3000/#/habit/42"))
        // Dropping the fragment is the Statistics button, and a document load.
        assertFalse(replacesEntry("http://pi:3000/#/habit/42", "http://pi:3000/"))
    }

    @Test
    fun `a habit route is the fragment routes-js writes, and nothing else`() {
        assertTrue(isHabitRoute("http://pi:3000/#/habit/42"))
        assertFalse(isHabitRoute("http://pi:3000/"))
        assertFalse(isHabitRoute("about:blank"))
        assertFalse(isHabitRoute(null))
        // Anchored at both ends, like HABIT_RE — anything else is the dashboard,
        // which is what routes.js does with an unrecognised fragment too.
        assertFalse(isHabitRoute("http://pi:3000/#/habit/42/extra"))
        assertFalse(isHabitRoute("http://pi:3000/#/habits/42"))
        assertFalse(isHabitRoute("http://pi:3000/#/habit/x"))
    }

    @Test
    fun `a different document is never the same one`() {
        assertFalse(isSameDocument("about:blank", "http://pi:3000/#/habit/42"))
        // Nothing loaded yet.
        assertFalse(isSameDocument(null, "http://pi:3000/#/habit/42"))
        // A different server, reached by changing the address and setting it back.
        assertFalse(
            isSameDocument("http://pi:3000/#/habit/42", "http://nas:3000/#/habit/42"),
        )
        // The path is compared, not just the origin — a trailing slash is the
        // difference between a URL the WebView normalised and one it did not.
        assertFalse(isSameDocument("http://pi:3000", "http://pi:3000/#/habit/42"))
    }
}
