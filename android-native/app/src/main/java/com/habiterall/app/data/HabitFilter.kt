package com.habiterall.app.data

import java.text.Normalizer
import java.util.Locale

/**
 * The main screen's search predicate, mirroring `shared/public/ui/store.js`'s
 * `fold` and `matchesQuery` — but NOT its threshold, and not its fold exactly.
 *
 * The two clients disagree about when a search is OFFERED, deliberately, and
 * restoring the symmetry here is a drift repair that undoes a decision: the web
 * keeps `dashboard.js`'s `SEARCH_FROM = 6` because a permanent row is only
 * worth a wide dashboard's spare width, while this screen has no threshold at
 * all and offers a 48dp icon from the first habit up. Neither predicate reaches
 * storage, so there is no shared truth the two could have drifted out of — only
 * two "is this control worth its space" answers to two budgets that are not
 * comparable. `android-native/CLAUDE.md` states it at length.
 *
 * The fold itself is not guaranteed identical either. `NFD` decomposes
 * precomposed accents the same way JS's `normalize('NFD')` does, but the two
 * runtimes do not agree on what counts as
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
     * A query as this object actually reads one — folded, then trimmed. Both
     * public functions below go through it, which is the point: [isActive] is
     * a claim about what [matches] is going to do, so the two must not be able
     * to compute "is there anything to search for" two different ways.
     */
    private fun folded(query: String): String = fold(query).trim()

    /**
     * Whether [query] narrows anything at all — the predicate a caller should
     * ask before telling a user a filter is live.
     *
     * NOT `query.isNotBlank()`, which is the same answer only for the queries
     * this fold leaves alone. [fold] strips every `Mn` codepoint BEFORE
     * [matches] looks at what is left, so a query that is only combining marks
     * — a bare U+0301, pasted or left behind by an orphaned dead key — folds
     * to the empty string and matches every habit, while being neither empty
     * nor whitespace. Asked the wrong way, the bar renders its active badge,
     * tints itself and announces "Search, filter active" over a list that is
     * complete, and the count reads "N of N".
     */
    fun isActive(query: String): Boolean = folded(query).isNotEmpty()

    /**
     * Whether [habit] is one a search for [query] should show.
     *
     * Matches the name OR the description — a habit called "Gym" whose
     * description says "swimming Tuesdays" is one people look for by the
     * second. A query that is not [isActive] matches everything, so a caller
     * with no filter live needs no special case of its own.
     */
    fun matches(habit: Habit, query: String): Boolean {
        val q = folded(query)
        if (q.isEmpty()) return true
        return fold(habit.name).contains(q) || fold(habit.description).contains(q)
    }
}
