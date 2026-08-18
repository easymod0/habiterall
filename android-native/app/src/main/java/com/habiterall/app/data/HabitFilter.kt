package com.habiterall.app.data

import java.text.Normalizer
import java.util.Locale

/**
 * The main screen's search box, mirroring `shared/public/ui/store.js`'s `fold`
 * and `matchesQuery` at the same threshold — but the fold itself is not
 * guaranteed identical. `NFD` decomposes precomposed accents the same way JS's
 * `normalize('NFD')` does, but the two runtimes do not agree on what counts as
 * a combining mark to strip, and they part ways in BOTH directions. A habit
 * named "Hawaiʻi" has an ʻokina (U+02BB), which is `Diacritic` but not `Mn`:
 * the web folds it away and this does not. The Devanagari anusvara (U+0902) is
 * the opposite, `Mn` but not `Diacritic`, so this strips it and the web does
 * not. Chasing an exact, character-for-character match is not worth what it
 * buys — `java.util.regex` has no `Diacritic` property at all, so it would
 * mean a hand-maintained codepoint table, and being wrong here costs a search
 * result rather than a wrong entry. See the sixth-mirror note below.
 *
 * Pure, and pinned by [com.habiterall.app.HabitFilterTest]. It reaches no
 * storage and no request, which is also why it is not a sixth mirror: the five
 * hand-written ones exist so two clients agree about a value that ends up on
 * disk, and disagreeing here costs a search result, not a wrong entry.
 */
object HabitFilter {

    /** Diacritics, once folding has moved them onto their own codepoint (NFD). */
    private val DIACRITICS = Regex("\\p{Mn}+")

    /**
     * Case- and accent-folded, so "cafe" finds "Café". `Locale.ROOT` is
     * deliberate, not an oversight: the device's default locale lowercases `I`
     * to `ı` on a Turkish phone, while JS's `toLowerCase()` is
     * locale-independent — using the default here would make the phone find
     * fewer habits than the web for the exact same query.
     */
    private fun fold(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFD)
            .replace(DIACRITICS, "")
            .lowercase(Locale.ROOT)

    /**
     * Whether [habit] is one a search for [query] should show.
     *
     * Matches the name OR the description — a habit called "Gym" whose
     * description says "swimming Tuesdays" is one people look for by the
     * second. An empty (or blank) query matches everything, so a caller with
     * no filter live needs no special case of its own.
     */
    fun matches(habit: Habit, query: String): Boolean {
        val q = fold(query).trim()
        if (q.isEmpty()) return true
        return fold(habit.name).contains(q) || fold(habit.description).contains(q)
    }
}
