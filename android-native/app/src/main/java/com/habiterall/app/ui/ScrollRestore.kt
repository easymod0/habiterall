package com.habiterall.app.ui

/**
 * Whether a restored list position is one to keep.
 *
 * Compose saves a `LazyListState` as an item index plus a pixel offset into that
 * item, and restores both when the app comes back. The pair is only meaningful
 * against the list it was saved from — and by the time it is restored, the list
 * has been fetched again and the rows have been measured again. So a position
 * that was exactly on a row boundary can come back as a fraction of a row, and
 * an index that existed can come back pointing past the end.
 *
 * Both look the same to the user: reopening the app shows a habit sliced in half
 * at the top of the screen.
 *
 * This is pure so the rule can be tested (`ScrollRestoreTest`) rather than
 * reasoned about. The previous version lived inline in the composable and
 * checked `index == 0 && offset > 0` — which fixed a clipped FIRST row and left
 * a clipped row at every other index, the case actually being reported.
 */
object ScrollRestore {

    /**
     * @param index  the restored first-visible item index
     * @param offset the restored pixel offset into that item
     * @param itemCount how many items the list now has
     * @return true when the position should be snapped back to the top
     */
    fun needsSnapToTop(index: Int, offset: Int, itemCount: Int): Boolean {
        // Nothing to scroll to, so nothing to correct.
        if (itemCount <= 0) return false

        // Negative values are not reachable through the API, but a restored
        // bundle is data from outside this process and cheap to be strict about.
        if (index < 0 || offset < 0) return true

        // The list shrank — a habit was archived or deleted on another device.
        if (index >= itemCount) return true

        // A partial row. Any offset at all means the top row is cut, and after a
        // restore that is never something the user chose: they left the app on a
        // boundary, and the rows were re-measured underneath them.
        if (offset > 0) return true

        return false
    }
}
