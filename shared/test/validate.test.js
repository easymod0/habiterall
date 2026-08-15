import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseHabit, parseEntry, assertDate, assertNotFuture,
  ValidationError, LIMITS, DEFAULT_COLOR,
} = await import('../src/validate.js');

const SENTINELS = { UNSET: 0, YES: 2, SKIP: 3 };
const boolHabit = { type: 'boolean' };
const numHabit = { type: 'numerical' };

/* ---------- habits ---------- */

test('a minimal habit is filled in with defaults', () => {
  const h = parseHabit({ name: 'Read' });
  assert.equal(h.name, 'Read');
  assert.equal(h.type, 'boolean');
  assert.equal(h.target_type, 'at_least');
  assert.equal(h.freq_numerator, 1);
  assert.equal(h.freq_denominator, 1);
  assert.equal(h.color, DEFAULT_COLOR);
  assert.equal(h.archived, false);
  // 'default' means "follow the account", which is the only value that changes
  // nothing — an override has to be asked for.
  assert.equal(h.at_most_unlogged, 'default');
});

test('the unlogged-day override is clamped to the three it may be', () => {
  // A habit PUT REPLACES, so this field is written on every save from every
  // client. Anything unrecognised has to land on 'default' rather than on
  // `success`, or a typo hands a limit a record it has not earned.
  assert.equal(parseHabit({ name: 'x', at_most_unlogged: 'success' }).at_most_unlogged,
    'success');
  assert.equal(parseHabit({ name: 'x', at_most_unlogged: 'miss' }).at_most_unlogged, 'miss');
  for (const junk of ['SUCCESS', 'yes', '', null, 1, {}, ['success']]) {
    assert.equal(
      parseHabit({ name: 'x', at_most_unlogged: junk }).at_most_unlogged, 'default',
      `${JSON.stringify(junk)} was not clamped`
    );
  }
});

test('name is required and trimmed', () => {
  assert.throws(() => parseHabit({ name: '   ' }), ValidationError);
  assert.throws(() => parseHabit({}), ValidationError);
  assert.equal(parseHabit({ name: '  Run  ' }).name, 'Run');
});

test('over-long text is rejected or clamped, consistently', () => {
  // The name is load-bearing, so an over-long one is an error...
  assert.throws(() => parseHabit({ name: 'x'.repeat(LIMITS.name + 1) }), ValidationError);
  // ...while free text is simply clamped rather than losing the whole request.
  const h = parseHabit({
    name: 'ok',
    description: 'd'.repeat(LIMITS.description + 50),
    unit: 'u'.repeat(LIMITS.unit + 50),
  });
  assert.equal(h.description.length, LIMITS.description);
  assert.equal(h.unit.length, LIMITS.unit);
});

test('frequency must be sane integers', () => {
  assert.throws(() => parseHabit({ name: 'x', freq_numerator: 0 }), ValidationError);
  assert.throws(() => parseHabit({ name: 'x', freq_numerator: 2.5 }), ValidationError);
  assert.throws(() => parseHabit({ name: 'x', freq_numerator: 8, freq_denominator: 7 }),
    ValidationError, 'numerator may not exceed denominator');
  assert.throws(() => parseHabit({ name: 'x', freq_denominator: LIMITS.freqDenominator + 1 }),
    ValidationError, 'a period longer than a year is not a habit');

  const ok = parseHabit({ name: 'x', freq_numerator: 3, freq_denominator: 7 });
  assert.equal(ok.freq_numerator, 3);
  assert.equal(ok.freq_denominator, 7);
});

test('the frequency cap is what bounds the score-saturation bug', () => {
  // A 1x/365d habit was the input that made a single completion report 100%
  // strength. The cap keeps the denominator to a year at most.
  assert.doesNotThrow(() => parseHabit({ name: 'x', freq_denominator: 365 }));
  assert.throws(() => parseHabit({ name: 'x', freq_denominator: 3650 }), ValidationError);
});

test('target_value must be a non-negative finite number', () => {
  assert.throws(() => parseHabit({ name: 'x', target_value: -1 }), ValidationError);
  assert.throws(() => parseHabit({ name: 'x', target_value: NaN }), ValidationError);
  assert.throws(() => parseHabit({ name: 'x', target_value: Infinity }), ValidationError);
  assert.equal(parseHabit({ name: 'x', target_value: 0 }).target_value, 0);
});

test('unknown enum values fall back rather than erroring', () => {
  const h = parseHabit({ name: 'x', type: 'telepathic', target_type: 'roughly' });
  assert.equal(h.type, 'boolean');
  assert.equal(h.target_type, 'at_least');
});

test('colour must be a 6-digit hex, else the default', () => {
  assert.equal(parseHabit({ name: 'x', color: '#ff8800' }).color, '#ff8800');
  assert.equal(parseHabit({ name: 'x', color: 'red' }).color, DEFAULT_COLOR);
  assert.equal(
    parseHabit({ name: 'x', color: '#fff" onload="alert(1)' }).color, DEFAULT_COLOR,
    'an injection attempt must not survive into the DOM'
  );
});

test('errors carry a 400 status for the API layer', () => {
  try {
    parseHabit({});
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 400);
    assert.equal(e.name, 'ValidationError');
  }
});

/* ---------- entries ---------- */

test('a boolean habit accepts only its sentinels', () => {
  assert.deepEqual(parseEntry(boolHabit, { value: 2 }, SENTINELS),
    { value: 2, status: '', notes: '' });
  assert.deepEqual(parseEntry(boolHabit, { value: 0 }, SENTINELS),
    { value: 0, status: '', notes: '' });
  assert.throws(() => parseEntry(boolHabit, { value: 42 }, SENTINELS), ValidationError);
});

test('a numerical habit accepts any non-negative amount', () => {
  assert.equal(parseEntry(numHabit, { value: 7.5 }, SENTINELS).value, 7.5);
  assert.equal(parseEntry(numHabit, { value: 0 }, SENTINELS).value, 0);
  assert.throws(() => parseEntry(numHabit, { value: -1 }, SENTINELS), ValidationError);
});

test('a numerical 3 is an amount, not a skip', () => {
  // Regression: skips were once stored in-band as the value 3, so "3
  // cigarettes" on an at-most habit was silently reclassified as a skip.
  const e = parseEntry(numHabit, { value: 3 }, SENTINELS);
  assert.equal(e.value, 3);
  assert.equal(e.status, '', 'must NOT be treated as a skip');
});

test('a boolean 3 IS the skip sentinel', () => {
  const e = parseEntry(boolHabit, { value: 3 }, SENTINELS);
  assert.equal(e.status, 'skip');
  assert.equal(e.value, 0, 'a skip never carries a value');
});

test('an explicit status wins for either habit type', () => {
  for (const h of [boolHabit, numHabit]) {
    const e = parseEntry(h, { status: 'skip' }, SENTINELS);
    assert.equal(e.status, 'skip');
    assert.equal(e.value, 0);
  }
});

test('notes are clamped and always present', () => {
  assert.equal(parseEntry(numHabit, { value: 1 }, SENTINELS).notes, '');
  const long = parseEntry(numHabit, { value: 1, notes: 'n'.repeat(LIMITS.notes + 50) }, SENTINELS);
  assert.equal(long.notes.length, LIMITS.notes);
});

/* ---------- dates ---------- */

test('dates must be YYYY-MM-DD', () => {
  assert.equal(assertDate('2026-08-12'), '2026-08-12');
  for (const bad of ['12-08-2026', '2026-8-12', 'today', '', null, '2026-08-12T00:00:00Z']) {
    assert.throws(() => assertDate(bad), ValidationError, `should reject ${bad}`);
  }
});

test('future dates are rejected against the caller\'s today', () => {
  assert.equal(assertNotFuture('2026-08-11', '2026-08-12'), '2026-08-11');
  assert.equal(assertNotFuture('2026-08-12', '2026-08-12'), '2026-08-12', 'today is allowed');
  assert.throws(() => assertNotFuture('2026-08-13', '2026-08-12'), ValidationError);
});
