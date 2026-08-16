package com.habiterall.app

import com.habiterall.app.ui.amountComplaint
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
    fun `a thousands group is refused, not read as a decimal point`() {
        // The bug this test is named for: a blanket comma-to-dot replace read
        // "10,000" as TEN, so a habit created with a goal of ten thousand steps
        // stored one of ten — met by every day, permanently complete, silent.
        // The server cannot catch it: `parseHabit` bounds nothing above, so ten
        // is a valid target.
        //
        // Refusing is the only honest answer, because it IS ambiguous: "1,500"
        // is fifteen hundred to one reader and one and a half to another.
        assertNull(parseAmount("10,000"))
        assertNull(parseAmount("1,500"))
        assertNull(parseAmount("100,000"))
        assertNull(parseAmount("12,345"))
    }

    @Test
    fun `a comma with no thousands in front of it is still a decimal point`() {
        // The rule needs a non-zero integer part, or it takes the European
        // decimals the comma handling exists for. Nothing precedes these commas
        // that could be counted in thousands.
        assertEquals(0.255, parseAmount("0,255")!!, 0.0)
        assertEquals(0.255, parseAmount(",255")!!, 0.0)
        assertEquals(0.5, parseAmount("0,500")!!, 0.0)
    }

    @Test
    fun `the generosity of toDoubleOrNull is not inherited`() {
        // None of these is something a person types into a box asking for a
        // goal, and each parsed to a number that then became the target. "1e3"
        // is the sharp one — a thousand, silently.
        assertNull(parseAmount("1e3"))
        assertNull(parseAmount("1E3"))
        assertNull(parseAmount("0x10"))
        assertNull(parseAmount("Infinity"))
        assertNull(parseAmount("NaN"))
        assertNull(parseAmount("+8"))
        assertNull(parseAmount("8d"))
        assertNull(parseAmount("8f"))
    }

    @Test
    fun `a negative target is refused here rather than at the server`() {
        // `parseHabit` refuses it too, so this is not the only guard — but a
        // form that can produce a value its own API rejects produces an error
        // message where the user asked for a habit.
        assertNull(parseAmount("-5"))
        assertNull(parseAmount("-0.5"))
    }

    @Test
    fun `the refusal says what to do about it`() {
        // "Not a number" is true of "eight" and unhelpful for "10,000", which
        // is a number and a reasonable thing to type. A refusal nobody can act
        // on is only half better than the silent ten it replaced.
        assertEquals(
            "Type it without the thousands separator — 10000, not 10,000.",
            amountComplaint("10,000"),
        )
        assertEquals("Not a number", amountComplaint("eight"))
        assertEquals("Not a number", amountComplaint("1e3"))
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
