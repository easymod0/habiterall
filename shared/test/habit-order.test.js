import { test } from 'node:test';
import assert from 'node:assert/strict';

const { HABIT_SORTS, resolveHabitSort, needsLastMiss, sortHabitPayloads } =
  await import('../src/habit-order.js');
const { SETTING_VALUES } = await import('../src/validate.js');

test('HABIT_SORTS is exactly the five literal values', () => {
  // Asserted against literal strings, not against `SETTING_VALUES.habitSort`
  // or anything else imported — a test comparing two imports of the same
  // constant cannot see either one drift from what the setting registry and
  // `ui/settings.js` actually spell.
  assert.deepEqual(HABIT_SORTS, ['manual', 'name', 'strength', 'streak', 'recently missed']);
});

test('SETTING_VALUES.habitSort and HABIT_SORTS are the same five, in the same order', () => {
  // The literal above pins ONE of the two registries. This pins them to each
  // other, in BOTH directions, which the wiring test at the bottom of this
  // file cannot do: that one iterates `SETTING_VALUES.habitSort`, so a value
  // present in `HABIT_SORTS` and missing from `SETTING_VALUES` is a value it
  // never visits and never reports. Without this assertion the comparator
  // could grow an arm the endpoint refuses to store, or the endpoint could
  // accept a value the comparator treats as identity — a setting that saves
  // and then does nothing, which is the failure `habitSort` is most likely to
  // regress into.
  assert.deepEqual(SETTING_VALUES.habitSort, HABIT_SORTS);
});

test('resolveHabitSort maps each of the five to itself and everything else to manual', () => {
  for (const sort of HABIT_SORTS) {
    assert.equal(resolveHabitSort(sort), sort, sort);
  }
  for (const bad of [undefined, null, '', 'nope', '__proto__', 'constructor', 42, {}]) {
    assert.equal(resolveHabitSort(bad), 'manual', String(bad));
  }
});

test('needsLastMiss is true only for "recently missed"', () => {
  for (const sort of HABIT_SORTS) {
    assert.equal(needsLastMiss(sort), sort === 'recently missed', sort);
  }
  assert.equal(needsLastMiss('nope'), false);
});

const payload = (id, name, score, currentStreak) => ({ id, name, score, currentStreak });

test('manual returns the incoming order, a new array, and does not mutate the input', () => {
  const input = [payload(1, 'C', 0.1, 1), payload(2, 'A', 0.9, 9), payload(3, 'B', 0.5, 5)];
  const frozenCopy = input.map((p) => ({ ...p }));

  const out = sortHabitPayloads(input, 'manual');
  assert.deepEqual(out, input, 'manual must preserve the incoming order');
  assert.notEqual(out, input, 'manual must return a NEW array object');
  assert.deepEqual(input, frozenCopy, 'the input array/objects must be unchanged');
});

test('name sorts ascending, case-insensitively', () => {
  const input = [
    payload(1, 'cherry', 0, 0), payload(2, 'apple', 0, 0), payload(3, 'Banana', 0, 0),
  ];
  const out = sortHabitPayloads(input, 'name');
  assert.deepEqual(out.map((p) => p.name), ['apple', 'Banana', 'cherry']);
});

test('strength sorts descending by score; streak sorts descending by currentStreak', () => {
  const input = [
    payload(1, 'A', 0.2, 3), payload(2, 'B', 0.9, 1), payload(3, 'C', 0.5, 7),
  ];
  assert.deepEqual(sortHabitPayloads(input, 'strength').map((p) => p.id), [2, 3, 1]);
  assert.deepEqual(sortHabitPayloads(input, 'streak').map((p) => p.id), [3, 1, 2]);
});

test('recently missed sorts most-recent-miss first, with no-miss last', () => {
  const input = [payload(1, 'A', 0, 0), payload(2, 'B', 0, 0), payload(3, 'C', 0, 0)];
  const lastMiss = new Map([[1, '2026-09-01'], [2, '2026-09-08'], [3, null]]);
  const out = sortHabitPayloads(input, 'recently missed', lastMiss);
  assert.deepEqual(out.map((p) => p.id), [2, 1, 3]);
});

test('a tie keeps the incoming order, for strength and for recently missed', () => {
  // Two equal scores, given in `position` order (id ascending here stands in
  // for the incoming ORDER BY position, id) — a stable sort must not reorder
  // them, and must not fall back to an id tiebreak either.
  const tiedStrength = [payload(5, 'X', 0.5, 0), payload(1, 'Y', 0.5, 0), payload(3, 'Z', 0.5, 0)];
  assert.deepEqual(sortHabitPayloads(tiedStrength, 'strength').map((p) => p.id), [5, 1, 3]);

  const tiedMiss = [payload(5, 'X', 0, 0), payload(1, 'Y', 0, 0), payload(3, 'Z', 0, 0)];
  const lastMiss = new Map([[5, '2026-09-01'], [1, '2026-09-01'], [3, '2026-09-01']]);
  assert.deepEqual(
    sortHabitPayloads(tiedMiss, 'recently missed', lastMiss).map((p) => p.id), [5, 1, 3]);

  // And a tie where every habit has NO miss at all — every entry falls into
  // the "sorts last" branch, so the incoming order must survive there too.
  const noneMissed = [payload(5, 'X', 0, 0), payload(1, 'Y', 0, 0), payload(3, 'Z', 0, 0)];
  assert.deepEqual(
    sortHabitPayloads(noneMissed, 'recently missed', new Map()).map((p) => p.id), [5, 1, 3]);
});

test('an unrecognised sort is identity, not a throw', () => {
  const input = [payload(1, 'B', 0, 0), payload(2, 'A', 0, 0)];
  for (const bad of [undefined, null, '', 'nope', '__proto__', 'constructor']) {
    assert.deepEqual(sortHabitPayloads(input, bad), input, String(bad));
  }
});

test('the wiring test: every non-manual value in SETTING_VALUES.habitSort actually reorders', () => {
  // This is what fails when somebody adds a sixth value to SETTING_VALUES and
  // no comparator arm for it — the setting would offer an option that
  // silently does nothing, exactly the defect this test exists to catch.
  const base = [payload(1, 'B', 0.2, 2), payload(2, 'A', 0.9, 9), payload(3, 'C', 0.5, 5)];
  const lastMiss = new Map([[1, '2026-09-01'], [2, '2026-09-08'], [3, null]]);

  for (const sort of SETTING_VALUES.habitSort) {
    if (sort === 'manual') continue;
    const before = base.map((p) => p.id);
    const after = sortHabitPayloads(base, sort, lastMiss).map((p) => p.id);
    assert.notDeepEqual(after, before, `sort "${sort}" did not change the order`);
  }
});
