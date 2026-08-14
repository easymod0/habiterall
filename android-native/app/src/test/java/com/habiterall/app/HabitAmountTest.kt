package com.habiterall.app

import com.habiterall.app.ui.formatAmount
import com.habiterall.app.ui.parseAmount
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The two ends of a habit's target: the box the user types in, and the number
 * that goes over the wire.
 *
 * Worth pinning because a wrong answer here is silent in both directions. A
 * target of 0 is a perfectly legal habit — `parseHabit` accepts it, it just means
 * "no target" — so text that fails to parse and falls back to zero produces a
 * habit that stores cleanly, draws normally, and can never be met. And a target
 * that formats as "3.0" is what the user then re-saves.
 */
class HabitAmountTest {

    @Test
    fun `a plain number parses`() {
        assertEquals(8.0, parseAmount("8")!!, 0.0)
        assertEquals(8.5, parseAmount("8.5")!!, 0.0)
        assertEquals(8.0, parseAmount("  8 ")!!, 0.0)
    }

    @Test
    fun `a decimal comma is a decimal point`() {
        // `KeyboardType.Decimal` shows the separator the phone's LOCALE uses,
        // which across most of Europe is a comma. Refusing it is not an option
        // the user has any way to work around — the keyboard does not offer a
        // full stop — and reading it as zero is worse than refusing.
        assertEquals(8.5, parseAmount("8,5")!!, 0.0)
        assertEquals(0.5, parseAmount(",5")!!, 0.0)
    }

    @Test
    fun `text that is not a number is not a number`() {
        // Null rather than 0.0, so the form can disable Save instead of storing
        // a target no entry can ever satisfy.
        assertNull(parseAmount(""))
        assertNull(parseAmount("   "))
        assertNull(parseAmount("eight"))
        assertNull(parseAmount("8 glasses"))
        assertNull(parseAmount("."))
    }

    @Test
    fun `a whole number shows without a decimal point`() {
        // The field is what the user sees, and "3.0" invites an edit that was
        // never needed. Loop shows 3.
        assertEquals("3", formatAmount(3.0))
        assertEquals("0", formatAmount(0.0))
        assertEquals("2.5", formatAmount(2.5))
    }

    @Test
    fun `what is shown is what parses back`() {
        // The round trip the edit form actually makes: read a stored target into
        // the box, save without touching it, and get the same number back.
        for (v in listOf(0.0, 1.0, 2.5, 8.0, 1000.0, 0.25)) {
            assertEquals("round trip of $v", v, parseAmount(formatAmount(v))!!, 0.0)
        }
    }
}
