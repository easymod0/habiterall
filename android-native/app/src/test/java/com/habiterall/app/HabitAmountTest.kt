package com.habiterall.app

import com.habiterall.app.ui.AmountFormat
import com.habiterall.app.ui.AmountFormat.COMMA
import com.habiterall.app.ui.AmountFormat.POINT
import com.habiterall.app.ui.amountComplaint
import com.habiterall.app.ui.deviceAmountFormat
import com.habiterall.app.ui.formatAmount
import com.habiterall.app.ui.parseAmount
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.util.Locale

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

    // Restoring, not merely saving: a test that changes the JVM-wide default
    // locale and never puts it back poisons every test class that runs after
    // it in the same process.
    private lateinit var originalLocale: Locale

    @Before
    fun captureLocale() {
        originalLocale = Locale.getDefault()
    }

    @After
    fun restoreLocale() {
        Locale.setDefault(originalLocale)
    }

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

    /**
     * Format `v` under `format` and parse the result back under the same
     * convention, asserting NON-NULL first with `v` in the message — so a
     * broken round trip fails naming the value it broke on, rather than an
     * unlabelled NPE off a bare `!!`.
     */
    private fun assertRoundTrips(v: Double, format: AmountFormat?) {
        // Deliberately not `format?.let { parseAmount(shown, it) } ?: parseAmount(shown)`:
        // that elvis fires on ANY null left-hand side, including a legitimate
        // refusal from `parseAmount(shown, format)` — which would silently
        // retry under the DEVICE default and hide exactly the mismatch this
        // test exists to catch.
        val shown = if (format != null) formatAmount(v, format) else formatAmount(v)
        val label = format?.name ?: "the device default"
        val parsed = if (format != null) parseAmount(shown, format) else parseAmount(shown)
        assertNotNull("formatAmount($v, $label) = \"$shown\", which parseAmount refused", parsed)
        assertEquals("round trip of $v under $label", v, parsed!!, 0.0)
    }

    @Test
    fun `what is shown is what parses back`() {
        // The round trip the edit form actually makes: read a stored target into
        // the box, save without touching it, and get the same number back.
        //
        // 2.345, 5.234, 1.005 and 72.125 are the shape that broke this: a
        // non-zero integer part with exactly three decimal places matches
        // GROUP_COMMA, so a `formatAmount` that always wrote a dot handed its
        // own COMMA parser a string it refused. Without these four the property
        // this test claims to hold was never exercised by a value that could
        // have broken it.
        val values = listOf(0.0, 1.0, 2.5, 8.0, 1000.0, 0.25, 2.345, 5.234, 1.005, 72.125)
        for (v in values) {
            assertRoundTrips(v, POINT)
            assertRoundTrips(v, COMMA)
            assertRoundTrips(v, null)
        }
    }

    @Test
    fun `each convention refuses the other's group, never its own`() {
        // The setting moves only the REFUSAL. A dot group is a number under
        // POINT and refused under COMMA; a comma group is the other way round.
        assertNull(parseAmount("10,000", POINT))
        assertEquals(10.0, parseAmount("10.000", POINT)!!, 0.0)
        assertNull(parseAmount("10.000", COMMA))
        assertEquals(10.0, parseAmount("10,000", COMMA)!!, 0.0)

        // Neither convention accepts a group — the ambiguity is symmetric — and
        // neither refuses a plain decimal, because a group is exactly three
        // digits and "8,5" or "0,255" is never that.
        assertEquals(8.5, parseAmount("8,5", POINT)!!, 0.0)
        assertEquals(8.5, parseAmount("8.5", POINT)!!, 0.0)
        assertEquals(8.5, parseAmount("8,5", COMMA)!!, 0.0)
        assertEquals(8.5, parseAmount("8.5", COMMA)!!, 0.0)
        assertEquals(0.255, parseAmount("0,255", POINT)!!, 0.0)
        assertEquals(0.255, parseAmount("0.255", COMMA)!!, 0.0)
        assertEquals(0.255, parseAmount(",255", POINT)!!, 0.0)
        assertEquals(0.255, parseAmount(".255", COMMA)!!, 0.0)
    }

    @Test
    fun `the device tier is read, and read at call time`() {
        Locale.setDefault(Locale.GERMANY)
        assertEquals(COMMA, deviceAmountFormat())
        // No explicit format: the call itself must ask the locale again.
        assertNull(parseAmount("10.000"))
        assertEquals(10.0, parseAmount("10,000")!!, 0.0)

        // The second half is what a file-scope `val` cannot pass: switching the
        // default back inside the SAME test body must flip the answers back.
        Locale.setDefault(Locale.US)
        assertEquals(POINT, deviceAmountFormat())
        assertEquals(10.0, parseAmount("10.000")!!, 0.0)
        assertNull(parseAmount("10,000"))
    }

    @Test
    fun `the complaint follows the convention`() {
        assertEquals(
            "Type it without the thousands separator — 10000, not 10.000.",
            amountComplaint("10.000", COMMA),
        )
        assertEquals(
            "Type it without the thousands separator — 10000, not 10,000.",
            amountComplaint("10,000", POINT),
        )
        assertEquals("Not a number", amountComplaint("eight", COMMA))
        assertEquals("Not a number", amountComplaint("eight", POINT))
    }

    @Test
    fun `the trigger is the parser, not the anchored group regex`() {
        // Anchoring GROUP_POINT/GROUP_COMMA (so the parser is not quadratic on
        // a long run of digits) is right for the PARSE, which already refuses
        // "1,234,567" — it has more than one separator, so DECIMAL refuses it
        // a line later regardless of which regex named it. But asking the
        // anchored regex directly for the ADVICE moved the anchoring where it
        // does not belong: "1,234,567" is not a GROUP by that regex, so a
        // build that asked it directly said "Not a number" about an input
        // that removing every comma from DOES turn into an amount — which is
        // exactly the sentence's own claim.
        assertEquals(
            "Type it without the thousands separator — 10000, not 10,000.",
            amountComplaint("1,234,567", POINT),
        )
        // The parse is unaffected either way: taking the commas out of
        // "10,000 steps" still leaves a non-digit trailing it, so this is
        // agreement with the web (`shared/public/ui/amount.js`) rather than a
        // second regression — the same sentence the web gives the same input.
        assertEquals("Not a number", amountComplaint("10,000 steps", POINT))
    }

    @Test
    fun `the round trip holds under a comma reader too`() {
        // formatAmount now takes the convention too — it never groups, under
        // either spelling — so what it writes for a given convention always
        // parses back under that SAME convention. Before that fix this walked
        // a list with no value of the breaking shape (a non-zero integer part
        // with exactly three decimal places, which matches GROUP_COMMA) and
        // passed against a `formatAmount` that always wrote a dot, which its
        // own COMMA parser then refused: 2.345, 5.234, 1.005 and 72.125 are
        // that shape.
        val values = listOf(0.0, 1.0, 2.5, 8.0, 1000.0, 0.25, 2.345, 5.234, 1.005, 72.125)
        for (v in values) {
            assertRoundTrips(v, POINT)
            assertRoundTrips(v, COMMA)
            assertRoundTrips(v, null)
        }
    }

    @Test
    fun `formatAmount writes the literal string parseAmount reads back, never a group`() {
        // The direct case beside the round trip: pin the exact strings rather
        // than `formatAmount(v, f) == formatAmount(v, f)`, which would pass
        // with the convention parameter dropped entirely.
        assertEquals("5,234", formatAmount(5.234, COMMA))
        assertEquals("5.234", formatAmount(5.234, POINT))
        assertEquals("10000", formatAmount(10000.0, COMMA)) // never grouped, either way
        assertEquals("10000", formatAmount(10000.0, POINT))
    }
}
