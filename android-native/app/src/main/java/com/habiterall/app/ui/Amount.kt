package com.habiterall.app.ui

import java.text.DecimalFormatSymbols
import java.util.Locale

/**
 * Which way a decimal point is spelled — `.` or `,`.
 *
 * There is exactly one reader of a typed amount now ([parseAmount]), used by
 * the habit form, the notification number pad and the day dialog's count
 * field alike; this is what tells all three which spelling of a thousands
 * group to refuse. See [deviceAmountFormat] for where the value comes from
 * and `android-native/CLAUDE.md` for why this is deliberately NOT a sixth
 * hand-written mirror of a server setting.
 */
enum class AmountFormat { POINT, COMMA }

/**
 * What THIS device writes a decimal point as. Asked at PARSE time, never held.
 *
 * `Locale.getDefault()` can change while the process is running — a settings
 * change, or the OS itself — so this is a function and never a `val` at file
 * scope, the same rule `ui/count-field.js` states for the web about the
 * locale or the setting changing while the module is loaded. Only a literal
 * `,` resolves to [AmountFormat.COMMA]; anything else — including the Arabic
 * decimal separator `٫`, which this app has no convention for — is
 * [AmountFormat.POINT].
 */
internal fun deviceAmountFormat(): AmountFormat =
    if (DecimalFormatSymbols.getInstance(Locale.getDefault()).decimalSeparator == ',')
        AmountFormat.COMMA else AmountFormat.POINT

/**
 * An amount as a person would write it: `3`, not `3.0` — and spelled the way
 * [format] reads a decimal point back, or a box that reads "8,5" and then
 * writes "8.5" back into itself has told its owner they typed it wrong: what
 * this writes goes straight back into [parseAmount] on the next Save, in the
 * habit form, the day dialog's [CountDialog] and the notification number pad
 * alike. See `formatAmount`'s own doc comment in `shared/public/ui/amount.js`
 * for the same argument made about the web.
 *
 * **Grouping stays at no size under either convention** — `10000`, never
 * `10.000` or `10,000` — which is what keeps the output inside
 * [parseAmount]'s own domain rather than producing the one form it refuses.
 * There is no thousands separator to get right here, only which character is
 * the decimal point.
 */
internal fun formatAmount(v: Double, format: AmountFormat = deviceAmountFormat()): String {
    val text = if (v == v.toLong().toDouble()) v.toLong().toString() else v.toString()
    return if (format == AmountFormat.COMMA) text.replace('.', ',') else text
}

/**
 * A typed amount as a number, or null if it is not one yet.
 *
 * The comma is the point. `KeyboardType.Decimal` shows whatever separator the
 * phone's locale uses, which across most of Europe is `,` — so "8,5" is what the
 * keyboard invites and `toDoubleOrNull` refuses, and the old elvis turned that
 * refusal into a silent target of 0 that no entry could ever meet. Half-typed
 * text still returns null; [HabitFormScreen] disables Save for it rather than
 * guessing, which is the same treatment the reminder time already gets.
 *
 * **A thousands group is refused, not guessed at.** A blanket comma-to-dot
 * replace read "10,000" as TEN, so a habit created with a goal of ten thousand
 * steps stored one of ten — a goal every day meets, on a habit that then looks
 * permanently complete and says nothing about it. The server cannot catch it
 * either: `parseHabit` coerces with `Number()` and bounds nothing above, so ten
 * is a perfectly valid target. It is genuinely ambiguous — "1,500" is fifteen
 * hundred to one reader and one and a half to another — and refusing is loud,
 * where guessing is silent and sometimes wrong by a factor of a thousand. A
 * non-zero integer part is required, so it fires on "10,000" and not on "0,255"
 * or ",255", where there are no thousands to separate.
 *
 * **[format] decides which spelling is a group, and never what is accepted.**
 * A group is refused under every convention, and neither convention accepts
 * one: "8,5" and "8.5" are both eight and a half under both, because a group is
 * exactly three digits. So a wrong guess at the device's convention can only
 * ever refuse something loudly; it can never store a row out by a thousand.
 * The consequence worth stating plainly: under [AmountFormat.COMMA], "10,000"
 * is **ten** (ten and zero thousandths) — which is what
 * `shared/public/ui/amount.js` answers for the same input on a comma account.
 * That is the convention working, not a regression.
 *
 * `toDoubleOrNull` is generous in other ways nobody types into a goal box:
 * "1e3" is a thousand, "0x10" is sixteen, "Infinity" and "NaN" both parse, and
 * "-5" is negative. Digits, at most one separator, nothing else.
 *
 * Note what this is NOT. `shared/public/ui/amount.js` reads a day's AMOUNT in
 * the web app and this reads a habit's TARGET here (among other surfaces); they
 * are not mirrors and the root CLAUDE.md says why — a client mirrors a rule
 * only if it must work offline, and creating a habit is server-authoritative.
 * What is shared is the refusal, because the ambiguity is the same and so is
 * the cost of getting it wrong. Do not copy the web's `MAX_AMOUNT`/`MIN_AMOUNT`
 * bounds or its six-place quantisation here — the two deliberately part in
 * their DOMAIN and agree only about the FORM.
 */
internal fun parseAmount(text: String, format: AmountFormat = deviceAmountFormat()): Double? {
    val trimmed = text.trim()
    // A group that reads as a thousands separator, spelled the way [format]
    // says a group is spelled.
    if (isGroup(trimmed, format)) return null

    val decimal = trimmed.replace(',', '.')
    // Digits with at most one separator, and nothing else — no sign, no
    // exponent, no hex, no word.
    if (!DECIMAL.matches(decimal)) return null

    return decimal.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }
}

private fun isGroup(trimmed: String, format: AmountFormat): Boolean =
    when (format) {
        AmountFormat.POINT -> GROUP_POINT.matches(trimmed)
        AmountFormat.COMMA -> GROUP_COMMA.matches(trimmed)
    }

/**
 * "10,000" and "1,500", but not "0,255" or ",255" — a comma-separated group,
 * refused under [AmountFormat.POINT], where a comma reads as a thousands
 * separator. See [parseAmount].
 *
 * **ANCHORED and matched whole**, not the unanchored `containsMatchIn` this
 * used to be: the unanchored form is quadratic on a long run of digits
 * (`js/polynomial-redos`), which `GROUPS` in `shared/public/ui/amount.js`'s own
 * comment records as the reason for its own anchoring. This is not a narrowing
 * for the parser — everything the loose form caught and this does not
 * ("12,345,678", "10,000.5", "1,500 steps") has more than one separator or a
 * non-digit in it, so [DECIMAL] refuses it a line later regardless.
 *
 * The `0*` is load bearing: without it "01,000" is not a group here while
 * "01.000" IS a number to [DECIMAL], so a leading zero would buy a silent 1.
 */
private val GROUP_POINT = Regex("^0*[1-9]\\d*,\\d{3}$")

/**
 * "10.000" and "1.500", but not "0.255" or ".255" — a dot-separated group,
 * refused under [AmountFormat.COMMA], where a dot reads as a thousands
 * separator. See [GROUP_POINT] for why this is anchored and what the `0*`
 * guards against.
 */
private val GROUP_COMMA = Regex("^0*[1-9]\\d*\\.\\d{3}$")

/** Digits and at most one separator. */
private val DECIMAL = Regex("^(\\d+(\\.\\d*)?|\\.\\d+)$")

/**
 * Why [parseAmount] refused, for someone looking at the box.
 *
 * "Not a number" is true of "eight" and unhelpful for "10,000", which IS a
 * number and a perfectly reasonable thing to type — it is refused because it
 * is ambiguous, not because it is nonsense. A refusal the user cannot act on
 * is only half better than the silent ten it replaced.
 *
 * **The trigger is [parseAmount] itself, twice, and not [isGroup] — the box
 * was refused, and removing every grouper makes it an amount.** `isGroup`
 * ANCHORED (`^0*[1-9]\d*[,.]\d{3}$`) so it does not fire on "1,234,567" —
 * more than one group, past what a thousands separator alone can explain —
 * so a build that asked it directly told that input "Not a number", where the
 * PARSE is unaffected by the anchoring: `DECIMAL` still refuses it a line
 * later regardless of which guard named it. The actionable sentence is still
 * owed there, because taking every comma out of "1,234,567" DOES leave
 * something [parseAmount] accepts, and the sentence claims exactly that.
 * "10,000 steps" answers "Not a number" either way, correctly: taking the
 * commas out leaves "10000 steps", still not an amount, so the box may not
 * suggest something it would refuse.
 *
 * A literal, constant sentence per convention — never a template over the
 * user's input. `shared/test/amount.test.js` regexes the literal out of this
 * source; a template would lose that and the cross-client agreement test
 * would go green while saying nothing. Only the TRIGGER above decides which
 * of the two sentences is shown; neither sentence names what was typed.
 */
internal fun amountComplaint(text: String, format: AmountFormat = deviceAmountFormat()): String {
    val grouper = if (format == AmountFormat.COMMA) '.' else ','
    val plain = text.trim().filter { it != grouper }
    val ambiguous = parseAmount(text, format) == null && parseAmount(plain, format) != null
    return when {
        !ambiguous -> "Not a number"
        format == AmountFormat.COMMA ->
            "Type it without the thousands separator — 10000, not 10.000."
        else ->
            "Type it without the thousands separator — 10000, not 10,000."
    }
}
