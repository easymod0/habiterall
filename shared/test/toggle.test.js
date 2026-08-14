import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { DAY, dayStateOf, nextDayState } = await import('../public/ui/toggle.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The examples below are mirrored in `GridTest.kt` case for case, deliberately.
 * A tap that means one thing in the browser and another on the phone is not a
 * difference anyone finds in a changelog.
 */

test('with both settings off, a day is done or not done and never unknown again', () => {
  // Loop's own default cycle. Note where it does NOT go: once a day has been
  // touched there is no way back to "no data" from the grid, which is why the
  // day editor keeps a Clear.
  const off = {};
  assert.equal(nextDayState(DAY.UNKNOWN, off), DAY.DONE);
  assert.equal(nextDayState(DAY.DONE, off), DAY.NO);
  assert.equal(nextDayState(DAY.NO, off), DAY.DONE);
});

test('skip days adds one step, between done and not done', () => {
  const skips = { skipDays: true };
  assert.equal(nextDayState(DAY.UNKNOWN, skips), DAY.DONE);
  assert.equal(nextDayState(DAY.DONE, skips), DAY.SKIP);
  assert.equal(nextDayState(DAY.SKIP, skips), DAY.NO);
  assert.equal(nextDayState(DAY.NO, skips), DAY.DONE);
});

test('question marks are what let a tap clear a day', () => {
  const marks = { questionMarks: true };
  assert.equal(nextDayState(DAY.NO, marks), DAY.UNKNOWN);
  assert.equal(nextDayState(DAY.UNKNOWN, marks), DAY.DONE);
  // Skips are still not in the cycle: the two settings are independent.
  assert.equal(nextDayState(DAY.DONE, marks), DAY.NO);
});

test('both on is the full four-state cycle', () => {
  const both = { skipDays: true, questionMarks: true };
  const seen = [];
  let state = DAY.UNKNOWN;
  for (let i = 0; i < 4; i++) {
    state = nextDayState(state, both);
    seen.push(state);
  }
  assert.deepEqual(seen, [DAY.DONE, DAY.SKIP, DAY.NO, DAY.UNKNOWN],
    'four taps must return the day to where it started');
});

test('a skipped day still moves on once skips are switched off', () => {
  // Turning the setting off does not erase the skips already recorded — an
  // imported Loop history is full of them — so a tap on one has to go somewhere.
  assert.equal(nextDayState(DAY.SKIP, {}), DAY.NO);
  assert.equal(nextDayState(DAY.SKIP, { questionMarks: true }), DAY.NO);
});

test('an unrecognised state is treated as unanswered', () => {
  // Belt and braces: the states arrive from a `dayStateOf` that reads server
  // data, and "I did it" is the only safe answer to a tap on something we
  // cannot name.
  assert.equal(nextDayState(/** @type {any} */ ('nonsense'), {}), DAY.DONE);
  assert.equal(nextDayState(/** @type {any} */ (undefined), {}), DAY.DONE);
});

test('no row is unknown; a row holding 0 is a stated no', () => {
  // The distinction the whole feature rests on. `value: 0` and `value:
  // undefined` are the same square unless question marks are on, and they are
  // never the same claim.
  assert.equal(dayStateOf({ value: undefined }), DAY.UNKNOWN);
  assert.equal(dayStateOf({ value: null }), DAY.UNKNOWN);
  assert.equal(dayStateOf({ value: 0 }), DAY.NO);
  assert.equal(dayStateOf({ value: 2, done: true }), DAY.DONE);
  assert.equal(dayStateOf({ value: 8, done: false }), DAY.NO,
    'a measurable day that fell short is a lapse, not an unknown');
  assert.equal(dayStateOf({ value: 0, isSkip: true }), DAY.SKIP);
  assert.equal(dayStateOf({ value: undefined, isSkip: true }), DAY.SKIP,
    'a skip is a skip however the value reads — it lives out of band');
});

test('the Kotlin mirror is pinned to the same cases', () => {
  // `Grid.nextState` and `Grid.dayStateOf` are this module in Kotlin. This does
  // not compile Kotlin — it fails if one of them stops declaring the four states
  // or the two flags, which is the drift that would leave the phone cycling
  // differently from the browser with every test still green.
  const kotlin = readFileSync(
    join(root, '..', 'android-native', 'app', 'src', 'main', 'java',
      'com', 'habiterall', 'app', 'data', 'Grid.kt'),
    'utf8'
  );

  assert.match(kotlin, /enum class DayState \{ UNKNOWN, DONE, SKIPPED, NO \}/);
  assert.match(kotlin, /fun nextState\([\s\S]*?skipDays: Boolean[\s\S]*?questionMarks: Boolean/);
  assert.match(kotlin, /fun dayStateOf\(value: Double\?, isSkip: Boolean, done: Boolean\)/);

  for (const state of Object.values(DAY)) {
    // 'unknown' -> UNKNOWN, 'skip' -> SKIPPED (Kotlin's own spelling).
    const name = state === 'skip' ? 'SKIPPED' : state.toUpperCase();
    assert.ok(kotlin.includes(`DayState.${name}`), `Grid.kt never mentions ${name}`);
  }
});
