import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  COMMON_TIMES, MINUTE_STEP, describe, describeReminderDays, format,
  hourOptions, isCanonical, minuteOptions, parseReminderDays, parseTimeInput,
  remindsOn, split, weekdayOf,
} = await import('../public/ui/time.js');

const { TIME_RE } = await import('../src/constants.js');

/* ---------- parsing what people actually type ---------- */

test('a canonical time is returned unchanged', () => {
  for (const value of ['00:00', '08:30', '13:45', '23:59']) {
    assert.equal(parseTimeInput(value), value);
  }
});

test('the separator can be anything reasonable', () => {
  for (const typed of ['8:30', '08:30', '8.30', '8h30', '8 30', '830']) {
    assert.equal(parseTimeInput(typed), '08:30', `failed on ${typed}`);
  }
});

test('a bare hour means the top of it', () => {
  assert.equal(parseTimeInput('8'), '08:00');
  assert.equal(parseTimeInput('08'), '08:00');
  assert.equal(parseTimeInput('23'), '23:00');
  assert.equal(parseTimeInput('0'), '00:00');
});

test('four digits are read as HHMM', () => {
  assert.equal(parseTimeInput('2030'), '20:30');
  assert.equal(parseTimeInput('0715'), '07:15');
  assert.equal(parseTimeInput('1200'), '12:00');
});

test('a half-typed minute still parses', () => {
  // Someone typing '8:3' on the way to '8:30' should not see an error mid-keystroke.
  assert.equal(parseTimeInput('8:3'), '08:03');
});

test('am and pm are understood, however they are written', () => {
  for (const typed of ['8:30 pm', '8:30pm', '8:30 PM', '8:30 p.m.', '830 pm']) {
    assert.equal(parseTimeInput(typed), '20:30', `failed on ${typed}`);
  }
  assert.equal(parseTimeInput('7 am'), '07:00');
  assert.equal(parseTimeInput('11:45 pm'), '23:45');
});

test('the two times that are always off by twelve', () => {
  // Midnight is 12am and noon is 12pm; 12 is the hour that does not shift.
  assert.equal(parseTimeInput('12 am'), '00:00');
  assert.equal(parseTimeInput('12:30 am'), '00:30');
  assert.equal(parseTimeInput('12 pm'), '12:00');
  assert.equal(parseTimeInput('12:30 pm'), '12:30');
});

test('empty means "no reminder", which is not the same as invalid', () => {
  // The caller does different things with these: one clears the reminder, the
  // other is a mistake worth reporting.
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(parseTimeInput(blank), '', `${JSON.stringify(blank)} should clear`);
  }
  assert.equal(parseTimeInput('lunchtime'), null);
});

test('nonsense is rejected rather than coerced', () => {
  const bad = [
    '25:00', '24:00', '8:60', '99', '12:345', '-1:00', '1:2:3',
    '8 xm', '8:30 zm', 'pm', ':30', '8:', 'NaN', '1e3', '013000',
    '13 pm',            // a 24-hour hour with a meridiem is a contradiction
    '0 am',             // there is no 0 o'clock in 12-hour time
  ];
  for (const value of bad) {
    assert.equal(parseTimeInput(value), null, `accepted ${JSON.stringify(value)}`);
  }
});

test('everything it returns is a time the server will accept', () => {
  // The parser is the only thing between a keyboard and `reminder_time`, so its
  // output has to satisfy the server's own regex — for every input above.
  const inputs = [
    '8', '8:3', '830', '2030', '12 am', '12 pm', '11:45 pm', '7am', '0',
    '23:59', '00:00', '9.05', '1 30 pm',
  ];
  for (const value of inputs) {
    const parsed = parseTimeInput(value);
    assert.ok(parsed !== null, `${value} should parse`);
    assert.ok(TIME_RE.test(parsed), `${value} produced ${parsed}, which the server rejects`);
  }
});

/* ---------- the dropdowns ---------- */

test('there is one option per hour, labelled both ways', () => {
  const hours = hourOptions();
  assert.equal(hours.length, 24);
  assert.equal(hours[0].value, '00');
  assert.equal(hours[23].value, '23');
  assert.match(hours[13].label, /^13\s+\(1 pm\)$/);
  assert.match(hours[0].label, /\(12 am\)/);
  assert.match(hours[12].label, /\(12 pm\)/);
  // Every value must be selectable as a real hour.
  for (const { value } of hours) {
    assert.ok(TIME_RE.test(`${value}:00`), `${value} is not an hour`);
  }
});

test('minutes step through the hour', () => {
  const minutes = minuteOptions();
  assert.equal(minutes.length, 60 / MINUTE_STEP);
  assert.equal(minutes[0].value, '00');
  assert.equal(minutes.at(-1).value, String(60 - MINUTE_STEP));
});

test('a typed odd minute stays selectable', () => {
  // Without this, reopening a habit set to 08:37 would show 08:35 and saving
  // would quietly move the reminder.
  const minutes = minuteOptions(37);
  assert.equal(minutes.length, 60 / MINUTE_STEP + 1);
  assert.ok(minutes.some((m) => m.value === '37'));
  // In order, not appended at the end.
  const values = minutes.map((m) => Number(m.value));
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
  // And an odd minute that is already a step is not duplicated.
  assert.equal(minuteOptions(30).length, 60 / MINUTE_STEP);
});

test('the shortcuts are all real times', () => {
  for (const value of COMMON_TIMES) {
    assert.ok(TIME_RE.test(value), `${value} is not a time`);
    assert.equal(parseTimeInput(value), value);
  }
});

/* ---------- helpers ---------- */

test('format pads', () => {
  assert.equal(format(8, 5), '08:05');
  assert.equal(format(0, 0), '00:00');
  assert.equal(format(23, 59), '23:59');
});

test('split returns numbers, and null for no reminder', () => {
  assert.deepEqual(split('08:30'), { hour: 8, minute: 30 });
  assert.equal(split(''), null);
  assert.equal(split('8:30'), null, 'split is for stored values, not typed ones');
});

test('isCanonical accepts the stored forms only', () => {
  assert.ok(isCanonical(''));
  assert.ok(isCanonical('08:30'));
  assert.ok(!isCanonical('8:30'));
  assert.ok(!isCanonical('24:00'));
});

test('describe reads a time back in both clocks', () => {
  assert.equal(describe('08:30'), '08:30 (8:30 am)');
  assert.equal(describe('20:05'), '20:05 (8:05 pm)');
  assert.equal(describe('00:00'), '00:00 (12:00 am)');
  assert.equal(describe('12:00'), '12:00 (12:00 pm)');
  assert.equal(describe(''), '');
});

/* ---------- which weekdays a reminder fires on ---------- */

/*
 * `reminder_days` is a 7-bit mask, bit N = `getDay()` N: bit 0 Sunday … bit 6
 * Saturday. Every fixture below is a LITERAL and every one of them is chosen
 * to be neither 127 nor 0 wherever it can be, because those two are the fixed
 * points of the rotation this convention exists to make explicit — a suite
 * written entirely in 127s passes against a mask read backwards, which is
 * precisely how Loop's Saturday-based bit order went unverified for so long.
 *
 *   Mon-Fri  = 62   (bits 1..5)
 *   Sat only = 64   (bit 6)
 *   Sun only = 1    (bit 0)
 *
 * The dates are a real, consecutive week: 2026-09-13 is a Sunday and
 * 2026-09-19 is the Saturday after it.
 */
const SUNDAY = '2026-09-13';
const MONDAY = '2026-09-14';
const FRIDAY = '2026-09-18';
const SATURDAY = '2026-09-19';

test('the default is every day, written as the literal 127', () => {
  // Asserted as a number and not against the exported constant: a test that
  // imports the value it checks pins the name and nothing else, and this
  // default is what every habit created before the field existed means.
  assert.equal(parseReminderDays(undefined), 127);
  assert.equal(parseReminderDays(null), 127);
});

test('a mask of 0 is legal and is never repaired to every day', () => {
  // The bug #78 refused to ship: a Loop reminder mask of 0 became a daily
  // reminder. 0 means the habit reminds on no day, and the schedulers simply
  // never match one. A PICKER may snap an emptied set back to all days; the
  // validator may not.
  assert.equal(parseReminderDays(0), 0);
  assert.equal(describeReminderDays(0), 'No days');
  for (const date of [SUNDAY, MONDAY, FRIDAY, SATURDAY]) {
    assert.equal(remindsOn(0, date), false, `0 must fire on no day, failed on ${date}`);
  }
});

test('a real mask is kept exactly', () => {
  assert.equal(parseReminderDays(62), 62);
  assert.equal(parseReminderDays(64), 64);
  assert.equal(parseReminderDays(1), 1);
  assert.equal(parseReminderDays(127), 127);
});

test('anything that is not a mask lands on every day', () => {
  // `typeof` first rather than `Number(raw)`: `Number([])` is 0 and
  // `Number(true)` is 1, so coercion would turn several spellings of "not a
  // mask" into "no day at all" or "Sundays only".
  for (const junk of ['62', 62.5, -1, 128, NaN, Infinity, true, [], [62], {},
    '__proto__', null, undefined]) {
    assert.equal(parseReminderDays(junk), 127,
      `failed on ${JSON.stringify(junk)} (${typeof junk})`);
  }
});

test('bit 0 is Sunday and bit 6 is Saturday, both ends asserted', () => {
  assert.equal(weekdayOf(SUNDAY), 0);
  assert.equal(weekdayOf(MONDAY), 1);
  assert.equal(weekdayOf(FRIDAY), 5);
  assert.equal(weekdayOf(SATURDAY), 6);
});

test('weekdayOf reads the string and never a zone', () => {
  // The caller has already decided whose day this is. Nothing here may consult
  // the process clock, so the answer has to be the same under any TZ.
  assert.equal(weekdayOf('2026-01-01'), 4);
  assert.equal(weekdayOf('2026-12-31'), 4);
  assert.equal(weekdayOf(''), null);
  assert.equal(weekdayOf('2026-9-13'), null, 'the padding is not cosmetic');
  assert.equal(weekdayOf(undefined), null);
});

test('a two-digit year is that year, not nineteen hundred and something', () => {
  // `Date.UTC(99, 0, 1)` silently means 1999-01-01, which is a FRIDAY; the year
  // 99 itself opens on a Thursday. An entry dated year 0099 is exactly the kind
  // of row `boundedRange` exists for, so the two must not be confused here.
  assert.equal(weekdayOf('0099-01-01'), 4);
  assert.equal(weekdayOf('0001-03-04'), 0);
});

test('Mon-Fri is 62, and it is off at both weekend ends', () => {
  assert.equal(remindsOn(62, MONDAY), true);
  assert.equal(remindsOn(62, FRIDAY), true);
  assert.equal(remindsOn(62, SUNDAY), false);
  assert.equal(remindsOn(62, SATURDAY), false);
});

test('Saturday only is 64 and Sunday only is 1 — not the other way round', () => {
  // The one pair that catches a mask read against Loop's own Saturday-based
  // bit order, where these two numbers are 1 and 2 instead.
  assert.equal(remindsOn(64, SATURDAY), true);
  assert.equal(remindsOn(64, SUNDAY), false);
  assert.equal(remindsOn(1, SUNDAY), true);
  assert.equal(remindsOn(1, SATURDAY), false);
});

test('every day fires on every day of a real week', () => {
  for (const date of [SUNDAY, MONDAY, '2026-09-15', '2026-09-16', '2026-09-17',
    FRIDAY, SATURDAY]) {
    assert.equal(remindsOn(127, date), true, `failed on ${date}`);
  }
});

test('an unreadable date is on no mask', () => {
  // It has no weekday, so no mask can name it. Both callers hand over a date
  // the clock constructed, so this branch is a bug elsewhere.
  assert.equal(remindsOn(127, 'not-a-date'), false);
  assert.equal(remindsOn(127, ''), false);
});

test('describeReminderDays names the days, in bit order', () => {
  // The names are supplied by the caller and indexed by `getDay()` — this
  // module has no imports and no locale, and `dates.test.js`'s source guard
  // refuses a hardcoded weekday array under `shared/public/` anyway. Two
  // languages, because a version that ignored the argument and reached for a
  // list of its own would pass with one. Spelled out here rather than taken
  // from `weekdayNames()`, which resolves against whatever locale the runner
  // is in — this suite is about the BITS, and it must read the same in all ten
  // of them.
  const en = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fr = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  assert.equal(describeReminderDays(62, en), 'Mon, Tue, Wed, Thu, Fri');
  assert.equal(describeReminderDays(64, en), 'Sat');
  assert.equal(describeReminderDays(1, en), 'Sun');
  assert.equal(describeReminderDays(65, en), 'Sun, Sat');
  assert.equal(describeReminderDays(62, fr), 'lun., mar., mer., jeu., ven.');
  assert.equal(describeReminderDays(64, fr), 'sam.');
});

test('the two masks that need no names at all', () => {
  // 'Every day' and 'No days' say more than seven names joined would, and they
  // are the two answers a picker's own summary line spends most of its life on.
  assert.equal(describeReminderDays(127, []), 'Every day');
  assert.equal(describeReminderDays(0, []), 'No days');
  // Junk reads back as what it WILL be stored as, not as a blank.
  assert.equal(describeReminderDays('62', []), 'Every day');
});
