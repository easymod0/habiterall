package com.habiterall.app

import com.habiterall.app.data.Category
import com.habiterall.app.data.Habit
import com.habiterall.app.ui.HabitSections
import com.habiterall.app.ui.ListRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `HabitSections.rows`, mirroring `shared/public/ui/dashboard.js`'s grouped
 * branch. Pure, so every case here is a direct call — no Robolectric.
 */
class HabitSectionsTest {

    private fun habit(id: Long, name: String, categoryId: Long? = null) =
        Habit(id = id, name = name, description = "logged from a test", categoryId = categoryId)

    private fun category(id: Long, name: String, color: String, position: Int) =
        Category(id = id, name = name, color = color, position = position)

    @Test
    fun `ungrouped returns only Entrys, in order, and no Header`() {
        val habits = listOf(habit(1, "Gym"), habit(2, "Read", categoryId = 5))
        val rows = HabitSections.rows(habits, categories = listOf(category(5, "Health", "#abc123", 0)), grouped = false)

        assertEquals(listOf(ListRow.Entry(habits[0]), ListRow.Entry(habits[1])), rows)
        assertTrue(rows.none { it is ListRow.Header })
    }

    @Test
    fun `a category holding nothing still yields its Header with count 0`() {
        val empty = category(id = 7, name = "Chores", color = "#112233", position = 2)
        val rows = HabitSections.rows(habits = emptyList(), categories = listOf(empty), grouped = true)

        val header = rows.filterIsInstance<ListRow.Header>().single { it.categoryId == 7L }
        assertEquals("Chores", header.name)
        assertEquals("#112233", header.color)
        assertEquals(0, header.count)
    }

    @Test
    fun `Uncategorised is the last Header even when every habit is categorised`() {
        val work = category(id = 1, name = "Work", color = "#654321", position = 0)
        val habits = listOf(habit(1, "Standup", categoryId = 1), habit(2, "Review", categoryId = 1))
        val rows = HabitSections.rows(habits, categories = listOf(work), grouped = true)

        val headers = rows.filterIsInstance<ListRow.Header>()
        assertEquals(2, headers.size)
        assertEquals(HabitSections.UNCATEGORISED, headers.last().name)
        assertNull(headers.last().color)
        assertNull(headers.last().categoryId)
    }

    @Test
    fun `an unresolvable categoryId lands under Uncategorised, and every habit is emitted once`() {
        val known = category(id = 2, name = "Health", color = "#ffaa00", position = 0)
        val habits = listOf(
            habit(1, "Gym", categoryId = 2),
            // 999L names a category deleted since this fetch.
            habit(2, "Ghost habit", categoryId = 999L),
            habit(3, "Read"),
        )
        val rows = HabitSections.rows(habits, categories = listOf(known), grouped = true)

        val entries = rows.filterIsInstance<ListRow.Entry>()
        assertEquals(habits.size, entries.size)
        assertEquals(habits.toSet(), entries.map { it.habit }.toSet())

        val uncategorisedHeaderIndex = rows.indexOfFirst { it is ListRow.Header && it.name == HabitSections.UNCATEGORISED }
        val ghostIndex = rows.indexOfFirst { it is ListRow.Entry && it.habit.id == 2L }
        assertTrue("the ghost habit must be drawn after the Uncategorised header", ghostIndex > uncategorisedHeaderIndex)
    }

    @Test
    fun `each Header count equals the number of Entrys that follow it before the next Header`() {
        val health = category(id = 1, name = "Health", color = "#ffaa00", position = 0)
        val work = category(id = 2, name = "Work", color = "#0000ff", position = 1)
        val habits = listOf(
            habit(1, "Gym", categoryId = 1),
            habit(2, "Meditate", categoryId = 1),
            habit(3, "Standup", categoryId = 2),
            habit(4, "No category"),
        )
        val rows = HabitSections.rows(habits, categories = listOf(health, work), grouped = true)

        var i = 0
        while (i < rows.size) {
            val row = rows[i]
            if (row is ListRow.Header) {
                var actual = 0
                var j = i + 1
                while (j < rows.size && rows[j] is ListRow.Entry) {
                    actual++
                    j++
                }
                assertEquals("header ${row.name}'s count must match its following entries", row.count, actual)
                i = j
            } else {
                i++
            }
        }
    }
}
