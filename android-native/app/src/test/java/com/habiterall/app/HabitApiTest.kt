package com.habiterall.app

import com.habiterall.app.data.Habit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `Habit.toInput()` is the bridge between what the server SAYS about a habit
 * and what this client WRITES back, and a field missing from it is silently
 * destructive.
 *
 * `PUT /habits/:id` replaces rather than merges — see `HabitInput` — and the
 * write serialiser has `encodeDefaults = true`, so an omitted field is not
 * left out of the request, it is sent as the Kotlin default and STORED. Both
 * callers of this bridge are "the habit I just fetched, with one thing
 * changed": unarchiving, and setting a reminder from the list. So dropping a
 * field there means tapping a reminder time resets something the user set
 * somewhere else, with nothing on any screen to say so.
 *
 * That is exactly what happened to `at_most_unlogged` when it was added: it
 * reached the read model and the write model and not the bridge between them,
 * and every existing test still passed.
 *
 * So this compares the two ENCODINGS rather than restating a field list, which
 * is the same reason `AppSettingsDefaultsTest` parses the registry instead of
 * copying it: a hand-written list is written by whoever forgot the field.
 */
class HabitApiTest {

    /** Mirrors `Api.writeJson` — the serialiser a habit write actually uses. */
    private val writeJson = Json { encodeDefaults = true; explicitNulls = false }

    /**
     * Every field set to something that is NOT its Kotlin default, so a
     * dropped field shows up as a difference rather than as two defaults
     * agreeing with each other — the failure mode `reminder_message` had in
     * the cloud round-trip suite for as long as it did.
     */
    private val habit = Habit(
        id = 7,
        name = "No soda",
        description = "Fewer is better",
        type = "numerical",
        unit = "cans",
        targetValue = 2.0,
        targetType = "at_most",
        freqNumerator = 3,
        freqDenominator = 7,
        color = "#ef4444",
        reminderTime = "08:30",
        reminderMessage = "Any soda today?",
        atMostUnlogged = "success",
        position = 4,
        archived = true,
    )

    @Test
    fun `every field a write carries is the habit's own value`() {
        val sent = writeJson.encodeToJsonElement(habit.toInput()).jsonObject
        val source = writeJson.encodeToJsonElement(habit).jsonObject

        for ((key, value) in sent) {
            assertEquals(
                "$key is sent as something other than the habit's own value — " +
                    "a habit PUT REPLACES, so this field is being reset on the server",
                source[key],
                value,
            )
        }
        // A bridge that sent nothing would pass the loop above vacuously.
        assertTrue("HabitInput carries suspiciously few fields", sent.size >= 12)
    }

    @Test
    fun `the unlogged-day override survives a write that is about something else`() {
        // Named on its own because the two callers are precisely this shape,
        // and because the symptom is a habit's streak and strength changing
        // after an action that had nothing to do with either.
        val sent = writeJson.encodeToJsonElement(habit.toInput().copy(archived = false)).jsonObject
        assertEquals(JsonPrimitive("success"), sent["at_most_unlogged"])
        assertEquals(JsonPrimitive("08:30"), sent["reminder_time"])
        assertEquals(JsonPrimitive(false), sent["archived"])
    }
}
