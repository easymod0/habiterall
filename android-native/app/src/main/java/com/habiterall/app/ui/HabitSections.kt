package com.habiterall.app.ui

import com.habiterall.app.data.Category
import com.habiterall.app.data.Habit

/**
 * A row the grouped list draws — a category's section header, or a habit.
 *
 * `HabitList`'s `LazyColumn` iterates a `List<ListRow>` once grouping is on,
 * which is why `ScrollRestore` and the notification-focus effect have to read
 * THIS list's size and index rather than the habit list's: once headers are
 * items, the item count is not the habit count and a habit's position in
 * `listRows` is not its position in `visible`.
 */
sealed interface ListRow {
    data class Header(val categoryId: Long?, val name: String, val color: String?, val count: Int) : ListRow
    data class Entry(val habit: Habit) : ListRow
}

/**
 * Partitions a habit list into sections, mirroring
 * `shared/public/ui/dashboard.js`'s grouped branch (`:315-330`) so the two
 * clients draw the same sections in the same order from the same input.
 *
 * Not a sixth mirror, for the reason `HabitFilter`'s KDoc gives for itself: a
 * mirror exists so two clients agree about a value that reaches storage, and
 * this partition reaches none — it only decides where a habit is DRAWN, not
 * what is stored about it. Disagreeing here costs a section a habit lands in
 * on screen, not a wrong entry.
 */
object HabitSections {
    /** The trailing section's name, matching `dashboard.js`'s `sectionHeader('Uncategorised', …)`. */
    const val UNCATEGORISED = "Uncategorised"

    /**
     * Ungrouped, this is `habits.map(ListRow::Entry)` and nothing else — the
     * flat list is byte-for-byte the list it always was.
     *
     * Grouped, three rules, matching `dashboard.js:315-330` exactly:
     * 1. every category in the order [categories] arrived in (the route
     *    already sorted by `position, id` — this does not re-sort), an empty
     *    one still drawing its header;
     * 2. an always-present trailing Uncategorised header, drawn even when it
     *    holds no habits;
     * 3. a habit whose `categoryId` names a category not in [categories] —
     *    deleted since this list was fetched — falls into Uncategorised
     *    rather than being dropped, so every habit in [habits] is emitted
     *    exactly once.
     */
    fun rows(habits: List<Habit>, categories: List<Category>, grouped: Boolean): List<ListRow> {
        if (!grouped) return habits.map(ListRow::Entry)

        val byCategory = LinkedHashMap<Long, MutableList<Habit>>()
        for (category in categories) byCategory[category.id] = mutableListOf()
        val uncategorised = mutableListOf<Habit>()
        for (habit in habits) {
            val bucket = habit.categoryId?.let { byCategory[it] }
            (bucket ?: uncategorised).add(habit)
        }

        val out = mutableListOf<ListRow>()
        for (category in categories) {
            val members = byCategory.getValue(category.id)
            out.add(ListRow.Header(category.id, category.name, category.color, members.size))
            for (habit in members) out.add(ListRow.Entry(habit))
        }
        // Uncategorised has no colour of its own.
        out.add(ListRow.Header(null, UNCATEGORISED, null, uncategorised.size))
        for (habit in uncategorised) out.add(ListRow.Entry(habit))
        return out
    }
}
