package com.habiterall.app

import com.habiterall.app.data.Habit
import com.habiterall.app.ui.toDraft
import com.habiterall.app.ui.toInput
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * `JSON_HABIT_FIELDS` (`shared/test/roundtrip-fixture.mjs`) is the declared
 * fidelity contract for a habit: every name in it is a field the habiterall
 * JSON backup — and, by the same coincidence that lets `HabitApiTest`'s fixture
 * work, every field `parseHabit` reads on a write — must carry across a round
 * trip. `HabitApiTest` iterates whatever keys `HabitInput` HAPPENS to send, so
 * a field present in NEITHER Kotlin model passes it vacuously; it can only ever
 * catch a field that got into one model and not the other. This test asks the
 * question that leaves open: is every field the SERVER considers part of a
 * habit even reaching `HabitInput` at all, and with the habit's OWN value
 * rather than `HabitInput`'s Kotlin default standing in for it?
 *
 * That second half is load-bearing and not obvious: `writeJson` has
 * `encodeDefaults = true`, so a field `HabitInput` DECLARES is always a key in
 * the output, wired or not — dropping `icon = icon` from `toInput()` still
 * emits `"icon": ""`, because that is also `HabitInput.icon`'s own default.
 * A presence-only check cannot tell "wired to the habit's value" from
 * "silently reset to the class default", which is exactly the failure mode
 * this field exists to catch, so the fixture below sets every field to
 * something OTHER than its Kotlin default and the assertion compares values,
 * not just keys.
 *
 * The oracle is that file rather than the object literal inside
 * `parseHabit` (`shared/src/validate.js`) for two reasons. First, it is
 * already the registry a THIRD consumer — the round-trip suites in both
 * editions — treats as the fidelity contract, so a fourth reader agreeing
 * with it is the same shape `AppSettingsDefaultsTest` uses for the settings
 * registry rather than a new one invented for this. Second, `parseHabit`
 * returns its object with the defaulting logic interleaved line by line;
 * pulling a clean field list out of that would be a harder parse solving a
 * weaker problem, since half its lines are not field names at all.
 *
 * This test would have caught `at_most_unlogged` shipping to the read model
 * and the write model and not the bridge between them — the exact bug
 * `HabitApiTest`'s own KDoc describes and that its own assertions could not
 * see. It catches `icon` failing to reach `HabitInput`, or reaching it but not
 * `toInput()`. And it catches whatever the next habit field is, the day it
 * lands in the fixture list and this file's own fixture Habit is updated to
 * give it a non-default value — the same manual step `HabitApiTest`'s fixture
 * already requires of a field it names.
 */
class HabitFieldCoverageTest {

    private val writeJson = Json { encodeDefaults = true; explicitNulls = false }

    /**
     * Every field set to something that is NOT its Kotlin default, for the
     * same reason `HabitApiTest`'s fixture is: two defaults agreeing with each
     * other is indistinguishable from a dropped field, which is the failure
     * mode both tests exist to catch.
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
        showAs = "avoid",
        icon = "🧘",
        archived = true,
    )

    /**
     * `shared/test/roundtrip-fixture.mjs`, found by walking up from wherever
     * the test runner started — the same technique `AppSettingsDefaultsTest`
     * uses for `settings.js`. Missing is a FAILURE rather than a skip: this
     * module lives in the habiterall repository and the file it mirrors is
     * always beside it.
     */
    private val fixtureSource: String by lazy {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "shared/test/roundtrip-fixture.mjs")
            if (candidate.isFile) return@lazy candidate.readText()
            dir = dir.parentFile
        }
        throw AssertionError(
            "shared/test/roundtrip-fixture.mjs not found above ${File("").absolutePath}. " +
                "It is the declared fidelity contract this test mirrors; without it this " +
                "test proves nothing."
        )
    }

    /**
     * Every `export const NAME = [...]` array in the fixture file, resolving
     * a leading `...OTHER_LIST` entry against a list already parsed earlier
     * in the same file — which is how `LOOP_DB_HABIT_FIELDS` and
     * `JSON_HABIT_FIELDS` are actually built there. Each array is read as a
     * flat, comma-separated list of tokens; a bare string literal is a field
     * name and a `...` token is a spread of a previously-resolved list.
     *
     * Read plainly rather than cleverly, for the same reason
     * `AppSettingsDefaultsTest.default()` is: a parse that has to be reasoned
     * about is one that can pass by accident.
     */
    private fun parseFieldLists(source: String): Map<String, List<String>> {
        val resolved = linkedMapOf<String, List<String>>()
        val listPattern = Regex("""export const ([A-Z_]+) = \[([\s\S]*?)];""")
        for (match in listPattern.findAll(source)) {
            val name = match.groupValues[1]
            val body = match.groupValues[2]
            val fields = mutableListOf<String>()
            for (rawToken in body.split(",")) {
                val token = rawToken.trim()
                if (token.isEmpty()) continue
                if (token.startsWith("...")) {
                    val ref = token.removePrefix("...").trim()
                    val refFields = resolved[ref]
                    assertTrue(
                        "`$name` spreads `$ref`, which this parse has not seen a " +
                            "definition for yet — has the fixture file been reordered?",
                        refFields != null,
                    )
                    fields += refFields!!
                } else {
                    fields += token.trim('\'', '"')
                }
            }
            resolved[name] = fields
        }
        return resolved
    }

    @Test
    fun `every fixture-declared habit field reaches the write model, with the habit's own value`() {
        val lists = parseFieldLists(fixtureSource)
        val fields = lists["JSON_HABIT_FIELDS"]
        assertTrue(
            "`JSON_HABIT_FIELDS` not found in shared/test/roundtrip-fixture.mjs — " +
                "has it been renamed?",
            fields != null,
        )

        // A parse that suddenly yields nothing would satisfy every assertion
        // below it, which is the exact defect this test exists to prevent.
        assertTrue(
            "parsed ${fields!!.size} fields out of JSON_HABIT_FIELDS — the shape " +
                "this test reads it by must have changed",
            fields.size >= 14,
        )

        val sent = writeJson.encodeToJsonElement(habit.toInput()).jsonObject
        val source = writeJson.encodeToJsonElement(habit).jsonObject

        for (field in fields) {
            assertTrue(
                "`$field` is in JSON_HABIT_FIELDS but HabitInput does not send it at " +
                    "all. A habit PUT REPLACES, so this field is being RESET on the " +
                    "server by the two callers that flip one thing about a habit they " +
                    "fetched — unarchiving, and setting a reminder time from the list.",
                sent.containsKey(field),
            )
            assertEquals(
                "`$field` is sent as something other than the habit's own value — " +
                    "declared on HabitInput but not wired through toInput(), which " +
                    "resets it on the server exactly as if it were missing.",
                source[field],
                sent[field],
            )
        }
    }

    /**
     * There are TWO write bridges, not one. `HabitFormScreen`'s `Draft` is a
     * second, independent path from a fetched [Habit] to a [HabitInput] —
     * `MainActivity` routes `Manage.EditHabit` through it — and it has its own
     * chance to drop a field the way `toInput()` above once dropped `icon`.
     *
     * The fixture habit above is deliberately one that survives the form's own
     * coercion unchanged: numerical, with a `reminderTime` already in canonical
     * `HH:MM` form and a `unit` the numerical branch keeps rather than blanks.
     * A field that legitimately cannot survive the round trip (none currently
     * do, for this fixture) belongs in a documented exclusion set here, the
     * way `notMirrored` documents one in `AppSettingsDefaultsTest` — not a
     * silent skip.
     */
    @Test
    fun `every fixture-declared habit field reaches the form's write bridge too`() {
        val lists = parseFieldLists(fixtureSource)
        val fields = lists["JSON_HABIT_FIELDS"]
        assertTrue(
            "`JSON_HABIT_FIELDS` not found in shared/test/roundtrip-fixture.mjs — " +
                "has it been renamed?",
            fields != null,
        )
        assertTrue(
            "parsed ${fields!!.size} fields out of JSON_HABIT_FIELDS — the shape " +
                "this test reads it by must have changed",
            fields.size >= 14,
        )

        // Fields the form is known to legitimately transform rather than carry
        // verbatim — none, for the fixture habit chosen above. A field added
        // here must name why, the way `notMirrored` does for a setting.
        val formCoerced = emptySet<String>()

        val sentViaForm = writeJson.encodeToJsonElement(habit.toDraft().toInput()).jsonObject
        val source = writeJson.encodeToJsonElement(habit).jsonObject

        for (field in fields) {
            if (field in formCoerced) continue
            assertTrue(
                "`$field` is in JSON_HABIT_FIELDS but HabitFormScreen's Draft.toInput() " +
                    "does not send it at all. A habit PUT REPLACES, so editing a habit " +
                    "from the phone's OWN form — not just the two callers that flip one " +
                    "thing about a fetched habit — resets this field on the server.",
                sentViaForm.containsKey(field),
            )
            assertEquals(
                "`$field` is sent by HabitFormScreen's form as something other than the " +
                    "habit's own value — declared on Draft/HabitInput but not wired " +
                    "through Draft.toDraft()/Draft.toInput(), which resets it on the " +
                    "server exactly as if the field were missing.",
                source[field],
                sentViaForm[field],
            )
        }
    }
}
