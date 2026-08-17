package com.habiterall.app

import com.habiterall.app.data.Habit
import com.habiterall.app.notify.Notifications
import com.habiterall.app.notify.Notifications.ReminderAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which buttons a reminder offers, and in what order.
 *
 * Pulled out of the builder for the reason `Grid` is pulled out of Compose:
 * inside `addAction` calls this is a decision no test can see, and every wrong
 * arrangement of it still posts a perfectly good notification. The one that
 * matters is the tail — the collapsed shade shows three, so the order decides
 * which button a user does not get.
 */
class ReminderActionsTest {

    private fun boolHabit() = Habit(id = 1, name = "Meditate")

    private fun waterHabit() =
        Habit(id = 2, name = "Water", type = "numerical", targetValue = 8.0)

    private fun avoidedHabit() = Habit(
        id = 3,
        name = "Smoking",
        type = "numerical",
        targetValue = 2.0,
        targetType = "at_most",
        showAs = "avoid",
    )

    @Test
    fun `a yes-no habit is answered with two buttons, and a measurable one with a number`() {
        assertEquals(
            listOf(ReminderAction.YES, ReminderAction.NO),
            Notifications.reminderActions(boolHabit(), skipEnabled = false, snoozeAvailable = false),
        )
        assertEquals(
            listOf(ReminderAction.COUNT),
            Notifications.reminderActions(waterHabit(), skipEnabled = false, snoozeAvailable = false),
        )
        // Stored as a measurable habit and answered yes-or-no: offering a
        // number pad for "did you smoke?" is the friction the rendering exists
        // to remove.
        assertEquals(
            listOf(ReminderAction.YES, ReminderAction.NO),
            Notifications.reminderActions(
                avoidedHabit(), skipEnabled = false, snoozeAvailable = false,
            ),
        )
    }

    @Test
    fun `snooze is last, so it is the button the shade drops`() {
        val actions = Notifications.reminderActions(
            boolHabit(), skipEnabled = true, snoozeAvailable = true,
        )
        assertEquals(
            listOf(
                ReminderAction.YES,
                ReminderAction.NO,
                ReminderAction.SKIP,
                ReminderAction.SNOOZE,
            ),
            actions,
        )
        // The claim that ordering is for: the three the shade shows are the
        // three that ANSWER the day. Put snooze anywhere earlier and an answer
        // is what falls off instead, which is the worse loss.
        assertFalse(
            "an answer must never be the button that falls off",
            ReminderAction.SNOOZE in actions.take(Notifications.VISIBLE_ACTIONS),
        )
    }

    @Test
    fun `a measurable habit keeps its snooze even with skips on`() {
        // The narrower true version of "it is the fourth button on an account
        // that uses skip days": a measurable habit spends ONE button on the
        // number pad, so all three of its actions are visible.
        val actions = Notifications.reminderActions(
            waterHabit(), skipEnabled = true, snoozeAvailable = true,
        )
        assertEquals(
            listOf(ReminderAction.COUNT, ReminderAction.SKIP, ReminderAction.SNOOZE),
            actions,
        )
        assertTrue(actions.size <= Notifications.VISIBLE_ACTIONS)
        // An avoided habit is answered yes/no, so it pays what a yes/no habit
        // pays and loses the same button.
        assertFalse(
            ReminderAction.SNOOZE in Notifications.reminderActions(
                avoidedHabit(), skipEnabled = true, snoozeAvailable = true,
            ).take(Notifications.VISIBLE_ACTIONS),
        )
    }

    @Test
    fun `a skip appears only when the account offers one, and so does a snooze`() {
        // `skipDays` is the account's and reaches here from the local mirror,
        // because an alarm fires on a phone that has not reached the server in
        // a week. A snooze with no room left in the day is absent for a
        // different reason and the same way: a button that can only say "too
        // late" is worse than no button.
        assertFalse(
            ReminderAction.SKIP in
                Notifications.reminderActions(
                    boolHabit(), skipEnabled = false, snoozeAvailable = true,
                ),
        )
        assertFalse(
            ReminderAction.SNOOZE in
                Notifications.reminderActions(
                    boolHabit(), skipEnabled = true, snoozeAvailable = false,
                ),
        )
    }
}
