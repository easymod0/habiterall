package com.habiterall.app.data

import java.text.Normalizer
import java.util.Locale

/**
 * The main screen's search box, mirroring `shared/public/ui/store.js`'s `fold`
 * and `matchesQuery` — the same box at the same threshold, so a habit found on
 * the web is found here too.
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
