package com.habiterall.app

import com.habiterall.app.data.Habit
import com.habiterall.app.data.HabitFilter.isActive
import com.habiterall.app.data.HabitFilter.matches
import java.util.Locale
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The main screen's search predicate, mirroring `store.js`'s `fold` and
 * `matchesQuery`. Pure, so every case here is a direct call — no Robolectric.
 */
class HabitFilterTest {

    /**
     * COMBINING ACUTE ACCENT, U+0301, written as an escape on purpose: as a
     * literal it is an invisible mark that attaches itself to whatever
     * character precedes it in the source, which is not a thing to leave a
     * reader guessing about.
     */
    private val COMBINING_ACUTE = "\u0301"

    private fun habit(name: String = "Gym", description: String = "") =
        Habit(id = 1, name = name, description = description)

    @Test
    fun `an empty query matches everything`() {
        assertTrue(matches(habit(), ""))
    }

    @Test
    fun `a blank-but-not-empty query matches everything`() {
        assertTrue(matches(habit(), "   "))
    }

    @Test
    fun `the description matches as well as the name`() {
        val h = habit(name = "Gym", description = "swimming Tuesdays")
        assertTrue(matches(h, "swimming"))
    }

    @Test
    fun `cafe finds Café`() {
        // The accent must not be the LAST character of the query's reach: NFD
        // places a combining mark after its base letter, so a bare "Café" vs
        // "cafe" passes even unstripped (the query is a literal prefix of
        // "cafe" + U+0301). Trailing text past the accent is what actually
        // requires the strip to bridge the combining mark.
        assertTrue(matches(habit(name = "Café Bar"), "cafe bar"))
    }

    @Test
    fun `an upper-case query finds a lower-case name, and vice versa`() {
        assertTrue(matches(habit(name = "gym"), "GYM"))
        assertTrue(matches(habit(name = "GYM"), "gym"))
    }

    /**
     * The case `isActive` exists for, and the one a blank check cannot see.
     *
     * U+0301 COMBINING ACUTE ACCENT with no base letter — reachable by a paste
     * or an orphaned dead-key sequence — is category `Mn`, so `fold` strips it
     * and `matches` is left with the empty string and shows every habit. It is
     * not empty and not whitespace, so `isNotBlank()` calls it a live filter
     * while the list it supposedly narrows is complete. Asserted as a PAIR, in
     * one test, because the defect is precisely the two disagreeing: either
     * answer alone is defensible, and only together do they pin the rule.
     */
    @Test
    fun `a query that folds away matches everything and is not active`() {
        assertTrue(matches(habit(name = "Gym"), COMBINING_ACUTE))
        assertFalse(isActive(COMBINING_ACUTE))
    }

    @Test
    fun `an empty or blank query is not active, and a real one is`() {
        assertFalse(isActive(""))
        assertFalse(isActive("   "))
        assertTrue(isActive("gym"))
        // Surrounding whitespace is trimmed, not counted: " gym " is the same
        // filter as "gym", and both are live.
        assertTrue(isActive("  gym  "))
    }

    /**
     * The control for the case above, and written DECOMPOSED on purpose.
     *
     * The tempting wrong fix for the test above is "a query holding a
     * combining mark is not a real query" — reject on `Mn` being present
     * rather than on what is left once it is stripped. Spelled `"café"` with a
     * precomposed U+00E9 that mutation survives, because there is no `Mn`
     * codepoint in the literal to see. Spelled `"cafe" + U+0301` — which is
     * what an IME emitting NFD hands over for the same word — it fails, while
     * folding-then-asking passes: there is a whole word left after the strip.
     */
    @Test
    fun `an accented word typed decomposed is still an active query`() {
        assertTrue(isActive("cafe" + COMBINING_ACUTE))
    }

    @Test
    fun `a query matching neither field returns false`() {
        val h = habit(name = "Gym", description = "swimming Tuesdays")
        assertFalse(matches(h, "piano"))
    }

    /**
     * The fold is case-folded with `Locale.ROOT`, and on a Turkish phone that
     * is the difference between finding a habit and not.
     *
     * `"PIANO".lowercase(Locale.getDefault())` under `tr` is `"pıano"` — a
     * dotless ı — while the name folds to `"piano"`, so the query matches
     * nothing. JS's `toLowerCase()` is locale-independent, so the browser
     * would have found it.
     *
     * What this does NOT catch, because there is nothing to catch: dropping
     * the argument for a bare `lowercase()`. Kotlin's is already `ROOT`, which
     * is the whole reason it exists apart from Java's `toLowerCase()` — so
     * `Locale.ROOT` there is explicitness, not the load-bearing part. What
     * breaks it is `Locale.getDefault()`, or a reviewer "simplifying" this to
     * Java's `String.toLowerCase()`, and both are one keystroke away. The JVM
     * running these tests is not Turkish, so every other case in this file
     * passes under either.
     */
    @Test
    fun `case folding does not follow the device locale`() {
        val was = Locale.getDefault()
        try {
            Locale.setDefault(Locale.forLanguageTag("tr"))
            assertTrue(matches(habit(name = "Piano"), "PIANO"))
        } finally {
            Locale.setDefault(was)
        }
    }
}
