package com.habiterall.app

import com.habiterall.app.ui.ScrollRestore.needsSnapToTop
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reported bug, as a test: close the app, reopen it, and a habit is sliced
 * in half at the top of the screen.
 *
 * The rule this pins used to live inline in the composable and read
 * `index == 0 && offset > 0`, which corrected a clipped FIRST row and left a
 * clipped row at every other index — so the symptom survived the fix that was
 * named after it.
 */
class ScrollRestoreTest {

    @Test
    fun `a position exactly on a row boundary is kept`() {
        // Someone deliberately scrolled to the third habit and came back. That
        // is theirs to keep.
        assertFalse(needsSnapToTop(index = 2, offset = 0, itemCount = 5))
        assertFalse(needsSnapToTop(index = 0, offset = 0, itemCount = 5))
        assertFalse(needsSnapToTop(index = 4, offset = 0, itemCount = 5))
    }

    @Test
    fun `a partial row is corrected at any index`() {
        // THE BUG. Every one of these renders a habit cut in half at the top,
        // and only the first was handled before.
        assertTrue("first row clipped", needsSnapToTop(0, 37, 5))
        assertTrue("second row clipped", needsSnapToTop(1, 37, 5))
        assertTrue("middle row clipped", needsSnapToTop(2, 5, 5))
        assertTrue("last row clipped", needsSnapToTop(4, 120, 5))
    }

    @Test
    fun `an index past the end is corrected`() {
        // The list shrank while the app was closed — a habit archived on the
        // laptop, or deleted on another phone.
        assertTrue(needsSnapToTop(5, 0, 5))
        assertTrue(needsSnapToTop(99, 0, 5))
    }

    @Test
    fun `an empty list needs no correction`() {
        // Nothing to scroll to. Snapping here would fight the loading state,
        // which is the moment the restored position is at its most stale.
        assertFalse(needsSnapToTop(0, 0, 0))
        assertFalse(needsSnapToTop(3, 40, 0))
    }

    @Test
    fun `nonsense from a restored bundle is corrected rather than trusted`() {
        // Not reachable through the API, but a saved bundle is data from outside
        // this process.
        assertTrue(needsSnapToTop(-1, 0, 5))
        assertTrue(needsSnapToTop(0, -1, 5))
    }

    @Test
    fun `a single habit still cannot be shown half-way`() {
        assertFalse(needsSnapToTop(0, 0, 1))
        assertTrue(needsSnapToTop(0, 12, 1))
    }
}
