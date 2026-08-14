package com.habiterall.app

import com.habiterall.app.data.HabitOrder.canMoveDown
import com.habiterall.app.data.HabitOrder.canMoveUp
import com.habiterall.app.data.HabitOrder.move
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reorder arithmetic.
 *
 * Worth pinning because the failure is not visual: the phone posts the whole
 * order to `POST /habits/reorder`, which writes each id's index as its
 * `position`. An off-by-one does not draw a row in the wrong place, it stores a
 * wrong order that the web app then faithfully agrees with.
 */
class HabitOrderTest {

    private val ids = listOf(10L, 20L, 30L, 40L)

    @Test
    fun `moving down shifts exactly one place`() {
        assertEquals(listOf(20L, 10L, 30L, 40L), move(ids, from = 0, to = 1))
        assertEquals(listOf(10L, 30L, 20L, 40L), move(ids, from = 1, to = 2))
    }

    @Test
    fun `moving up shifts exactly one place`() {
        assertEquals(listOf(10L, 30L, 20L, 40L), move(ids, from = 2, to = 1))
        assertEquals(listOf(40L, 10L, 20L, 30L), move(ids, from = 3, to = 0))
    }

    @Test
    fun `every id survives a move`() {
        // The list is written to the database wholesale, so losing or
        // duplicating one is data loss rather than a display bug.
        for (from in ids.indices) {
            for (to in ids.indices) {
                val moved = move(ids, from, to)
                assertEquals("size changed moving $from -> $to", ids.size, moved.size)
                assertEquals("membership changed moving $from -> $to", ids.toSet(), moved.toSet())
            }
        }
    }

    @Test
    fun `a move to the same place is the same list`() {
        assertEquals(ids, move(ids, from = 2, to = 2))
    }

    @Test
    fun `an index off the end changes nothing`() {
        // Reachable: a habit deleted on the web while this screen is open
        // shrinks the list under a tap already in flight. Doing nothing beats
        // crashing, and beats writing an order built from a stale index.
        assertEquals(ids, move(ids, from = 4, to = 0))
        assertEquals(ids, move(ids, from = 0, to = 9))
        assertEquals(ids, move(ids, from = -1, to = 1))
        assertEquals(emptyList<Long>(), move(emptyList(), from = 0, to = 0))
    }

    @Test
    fun `the ends are where the buttons stop`() {
        assertFalse(canMoveUp(0))
        assertTrue(canMoveUp(1))
        assertTrue(canMoveDown(0, ids.size))
        assertFalse(canMoveDown(ids.size - 1, ids.size))
        // A single habit can go neither way, and an empty list has no row to ask
        // about — both are states the screen actually reaches.
        assertFalse(canMoveUp(0))
        assertFalse(canMoveDown(0, 1))
        assertFalse(canMoveDown(0, 0))
    }
}
