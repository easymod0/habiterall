import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  COMMON_TIMES, MINUTE_STEP, describe, format, hourOptions, isCanonical,
  minuteOptions, parseTimeInput, split,
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
