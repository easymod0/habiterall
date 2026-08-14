package com.habiterall.app

import com.habiterall.app.ui.WebBackStack.floorAfterShow
import com.habiterall.app.ui.WebBackStack.shouldWalkHistory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What Back does, once the WebView outlives the screen.
 *
 * The regression this guards is silent and only appears on the SECOND tap: with
 * a WebView built fresh per open, `canGoBack()` was false on a deep link and
 * Back closed the screen. Reusing the WebView leaves earlier entries in the
 * list, so the same press started walking the page to the web dashboard instead
 * of returning to the native habit list — the app appearing to refuse to close a
 * screen, which is the exact symptom `routes.go()` already has a note about.
 */
class WebBackStackTest {

    @Test
    fun `the first open closes rather than walking back to the warm-up`() {
        // about:blank committed at 0, the habit lands at 1.
        val floor = floorAfterShow(indexBeforeLoad = 0, navigated = true)
        assertEquals(1, floor)
        assertFalse(
            "Back on the first habit must return to the native list",
            shouldWalkHistory(currentIndex = 1, floor = floor, canGoBack = true),
        )
    }

    @Test
    fun `a tap before the warm-up committed lands on the same floor`() {
        // Nothing committed yet, so the target REPLACES the pending entry and
        // commits at 0 rather than after it. Without the clamp the floor would
        // be 0 while the index is 0 — which happens to work — but an unclamped
        // -1 + 1 for a list that later grows is how an off-by-one hides.
        val floor = floorAfterShow(indexBeforeLoad = -1, navigated = true)
        assertEquals(0, floor)
        assertFalse(shouldWalkHistory(currentIndex = 0, floor = floor, canGoBack = false))
    }

    @Test
    fun `reopening the habit already loaded does not raise the floor`() {
        // Open a habit, Back to the list, open the same one again. Nothing
        // navigates, so nothing was pushed — and a floor raised here would sit
        // one above the current index forever, leaving a screen Back could not
        // close.
        val floor = floorAfterShow(indexBeforeLoad = 1, navigated = false)
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
}
