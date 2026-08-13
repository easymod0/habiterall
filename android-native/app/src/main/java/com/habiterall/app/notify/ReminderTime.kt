package com.habiterall.app.notify

/**
 * Reading and writing a reminder time on this client.
 *
 * A deliberate mirror of `shared/public/ui/time.js` — the web app and this one
 * write the same `reminder_time` field on the same habit, so "8:30 pm" has to
 * mean the same thing in both, or a reminder set on the phone reads differently
 * in the browser. The two files' tests cover the same cases for that reason:
 * `shared/test/time.test.js` and `ReminderTimeTest`.
 *
 * The dialog used to be a bare text field validated against `^HH:MM$`, which
 * rejected nearly every form a person actually types.
 */
object ReminderTime {

    /** The stored form. Matches TIME_RE in shared/src/constants.js. */
    private val CANONICAL = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

    /** Minute granularity of the dropdown; any minute can still be typed. */
    const val MINUTE_STEP = 5

    /** Times worth one tap — the round numbers people reach for. */
    val COMMON = listOf("07:00", "08:00", "12:00", "18:00", "21:00")

    private val WITH_SEPARATOR = Regex("^(\\d{1,2})\\s*[:.h\\s]\\s*(\\d{1,2})$")
    private val ONE_OR_TWO_DIGITS = Regex("^\\d{1,2}$")
    private val THREE_OR_FOUR_DIGITS = Regex("^\\d{3,4}$")
    private val MERIDIEM = Regex("\\s*([ap])\\.?\\s*m\\.?$")

    /**
     * Parse what was typed.
     *
     * @return "HH:MM"; "" when the input is blank, which means "no reminder";
     *   null when it is not a time at all. Blank and null are different
     *   answers: one clears the reminder, the other is a mistake to report.
     */
    fun parse(raw: String?): String? {
        val text = raw?.trim()?.lowercase() ?: return ""
        if (text.isEmpty()) return ""

        // Take the meridiem off first, so what remains is only digits.
        val suffix = MERIDIEM.find(text)
        val body = (if (suffix != null) text.substring(0, suffix.range.first) else text).trim()
        val meridiem = suffix?.groupValues?.get(1)

        var hour: Int
        val minute: Int

        val separated = WITH_SEPARATOR.matchEntire(body)
        when {
            separated != null -> {
                hour = separated.groupValues[1].toInt()
                minute = separated.groupValues[2].toInt()
            }
            ONE_OR_TWO_DIGITS.matches(body) -> {
                hour = body.toInt()
                minute = 0
            }
            // "830" and "2030": the last two digits are the minutes.
            THREE_OR_FOUR_DIGITS.matches(body) -> {
                hour = body.dropLast(2).toInt()
                minute = body.takeLast(2).toInt()
            }
            else -> return null
        }

        if (minute > 59) return null

        if (meridiem != null) {
            // 12am is 00:00 and 12pm is 12:00 — the one pair that trips every
            // hand-rolled conversion, since 12 is the hour that does not shift.
            if (hour < 1 || hour > 12) return null
            hour = if (meridiem == "a") {
                if (hour == 12) 0 else hour
            } else {
                if (hour == 12) 12 else hour + 12
            }
        }

        if (hour > 23) return null
        return format(hour, minute)
    }

    fun format(hour: Int, minute: Int): String = "%02d:%02d".format(hour, minute)

    /** True for the stored forms only, including "" for no reminder. */
    fun isCanonical(value: String?): Boolean =
        value != null && (value.isEmpty() || CANONICAL.matches(value))

    /** ("08", "30"), or null for "" and anything unparseable. */
    fun split(value: String?): Pair<String, String>? {
        if (value == null || !CANONICAL.matches(value)) return null
        val parts = value.split(":")
        return parts[0] to parts[1]
    }

    /** Hour options, labelled in both clocks: "13  (1 pm)". */
    fun hours(): List<Pair<String, String>> = (0..23).map { hour ->
        "%02d".format(hour) to "%02d  %s".format(hour, twelveHour(hour))
    }

    /** Minutes at [MINUTE_STEP], plus [extra] when it falls between them. */
    fun minutes(extra: Int? = null): List<String> {
        val stepped = (0 until 60 step MINUTE_STEP).toMutableList()
        // A time typed as 08:37 must stay selectable, or reopening the dialog
        // would show 08:35 and saving would quietly move the reminder.
        if (extra != null && extra in 0..59 && !stepped.contains(extra)) {
            stepped.add(extra)
            stepped.sort()
        }
        return stepped.map { "%02d".format(it) }
    }

    /** "08:30 (8:30 am)", for reading a time back. Never stored. */
    fun describe(value: String?): String {
        val parts = split(value) ?: return ""
        val hour = parts.first.toInt()
        val suffix = if (hour < 12) "am" else "pm"
        val twelve = if (hour % 12 == 0) 12 else hour % 12
        return "$value ($twelve:${parts.second} $suffix)"
    }

    private fun twelveHour(hour: Int): String {
        val suffix = if (hour < 12) "am" else "pm"
        val twelve = if (hour % 12 == 0) 12 else hour % 12
        return "($twelve $suffix)"
    }
}
