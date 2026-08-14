package com.habiterall.app.data

/**
 * Moving a habit up or down the list.
 *
 * `POST /habits/reorder` takes the ids in their new order and writes each one's
 * index as its `position`, so the whole job on this side is producing that list
 * correctly. Which sounds too small to name until you notice what it is used
 * for: the phone sends the WHOLE order on every nudge, so an off-by-one here
 * does not mis-draw a row, it writes a wrong order to the database that the web
 * app then agrees with.
 *
 * Pure, and pinned by [com.habiterall.app.HabitOrderTest], in the style of
 * [com.habiterall.app.ui.ScrollRestore] and
 * [com.habiterall.app.ui.WebBackStack].
 */
object HabitOrder {

    /**
     * [ids] with the item at [from] moved to [to].
     *
     * Out-of-range indices return the list unchanged rather than throwing. They
     * are reachable: the buttons are disabled at the ends, but a list that
     * shrank under a refetch — a habit deleted on the web while this screen was
     * open — can leave a tap in flight against an index that no longer exists,
     * and a crash is a worse answer than doing nothing.
     */
    fun move(ids: List<Long>, from: Int, to: Int): List<Long> {
        if (from == to) return ids
        if (from !in ids.indices || to !in ids.indices) return ids

        val out = ids.toMutableList()
        out.add(to, out.removeAt(from))
        return out
    }

    /** Whether the row at [index] can go up. */
    fun canMoveUp(index: Int): Boolean = index > 0

    /** Whether the row at [index] of a list of [size] can go down. */
    fun canMoveDown(index: Int, size: Int): Boolean = index >= 0 && index < size - 1
}
