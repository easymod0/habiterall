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

  // The encoding beside the cycle, and the refusal beside it. Both were
  // hand-applied twice — once here, once in Kotlin — and the first attempt got
  // the second file backwards, teaching Kotlin the web's bug instead of the
  // reverse. Nothing failed, because nothing looked.
  assert.match(kotlin, /fun valueForState\(habit: Habit, state: DayState\)/,
    'Grid.kt has no valueForState — the encoding is mirrored, not shared');
  assert.match(kotlin, /state == DayState\.SKIPPED ->[\s\S]{0,40}?error\(/,
    'Grid.kt no longer refuses to encode a skip; the web throws for it');
});

test('the two isAvoided implementations ask the same questions', () => {
  // Not in Grid.kt: the phone's lives on the Habit model in Api.kt, so the
  // check above never saw it. It had to be fixed in two files when a review
  // found it asking two of its three questions, and the next such fix can land
  // in one — which is what this exists to stop.
  const kotlin = readFileSync(
    join(root, '..', 'android-native', 'app', 'src', 'main', 'java',
      'com', 'habiterall', 'app', 'data', 'Api.kt'),
    'utf8'
  );
  const decl = /val isAvoided get\(\) =([\s\S]{0,120}?)\n\n/.exec(kotlin);
  assert.ok(decl, 'Api.kt no longer declares isAvoided');

  // All three questions, in whichever order each language spells them.
  for (const [what, kt] of [
    ['the rendering', /showAs == "avoid"/],
    ['an at-most target', /targetType == "at_most"/],
    ['a measurable habit', /isNumerical/],
  ]) {
    assert.match(decl[1], kt, `Kotlin's isAvoided stopped asking about ${what}`);
  }

  // And the web's, read from its own source rather than by calling it, so a
  // clause deleted here is as loud as one deleted there.
  const web = readFileSync(join(root, 'public', 'ui', 'toggle.js'), 'utf8');
  const body = web.slice(web.indexOf('export function isAvoided'));
  const js = body.slice(0, body.indexOf('}'));
  for (const [what, re] of [
    ['the rendering', /show_as === 'avoid'/],
    ['an at-most target', /target_type === 'at_most'/],
    ['a measurable habit', /type === 'numerical'/],
  ]) {
    assert.match(js, re, `the web's isAvoided stopped asking about ${what}`);
  }
});

/* ---------- a habit shown as something to avoid ---------- */

const { isAvoided, valueForState } = await import('../public/ui/toggle.js');
const values = await import('../public/ui/values.js');

const avoidHabit = {
  type: 'numerical', target_type: 'at_most', target_value: 0, show_as: 'avoid',
};

test('toggle.js\'s own copy of the wire values matches ui/values.js', () => {
  // It declares them locally so this file can be run with no module
  // resolution; that makes it a third copy, and a third copy drifts unless
  // something says otherwise. Read out of the source rather than the exports,
  // since they are deliberately not exported.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'ui', 'toggle.js'), 'utf8');
  const line = /const UNSET = (\d+), YES = (\d+), SKIP = (\d+);/.exec(src);
  assert.ok(line, 'toggle.js no longer declares the three values in one line');
  assert.equal(Number(line[1]), values.UNSET);
  assert.equal(Number(line[2]), values.YES);
  assert.equal(Number(line[3]), values.SKIP);
});

test('the cycle is untouched by any of this', () => {
  // The whole reason this feature is small. A habit you are trying not to do
  // walks the same four states in the same order — a clean day is `done`, a
  // slip is `no` — so `nextDayState`, which the Kotlin `Grid.nextState`
  // mirrors, did not have to learn anything.
  //
  // Written as a table rather than as a loop comparing the function with
  // ITSELF, which is what stood here: `nextDayState` takes no habit, so
  // "untouched by `show_as`" is true of its signature and twelve assertions
  // of `f(x) === f(x)` proved nothing. Both preferences could be deleted from
  // the function outright and this test stayed green.
  const cycles = [
    [{},                                     ['done', 'no',   'no', 'done']],
    [{ skipDays: true },                     ['done', 'skip', 'no', 'done']],
    [{ questionMarks: true },                ['done', 'no',   'no', 'unknown']],
    [{ skipDays: true, questionMarks: true }, ['done', 'skip', 'no', 'unknown']],
  ];
  for (const [prefs, expected] of cycles) {
    assert.deepEqual(
      ['unknown', 'done', 'skip', 'no'].map((s) => nextDayState(s, prefs)),
      expected,
      `cycle under ${JSON.stringify(prefs)}`);
  }
  assert.equal(nextDayState('unknown'), 'done');
  assert.equal(nextDayState('done'), 'no');
});

test('what a tap records is what differs, and only that', () => {
  // done is a CLEAN day on an avoided habit — the goal — and `no` is a slip.
  assert.equal(valueForState(avoidHabit, 'done'), 0);
  assert.equal(valueForState(avoidHabit, 'no'), 1);
  // A normal habit is unchanged.
  const normal = { type: 'boolean', target_type: 'at_least', target_value: 0 };
  assert.equal(valueForState(normal, 'done'), values.YES);
  assert.equal(valueForState(normal, 'no'), values.UNSET);
  // A skip is the status column and never a value, so asking for one is a
  // programming error rather than an encoding. Returning the SKIP sentinel
  // here stored a measurable habit's skip as THREE OF THE THING — three
  // cigarettes on an avoided habit, counted as a real miss — because
  // `parseEntry` reads 3 as a skip only for a yes/no habit.
  assert.throws(() => valueForState(avoidHabit, 'skip'), /status column/);
  assert.throws(() => valueForState(normal, 'skip'), /status column/);
});

test('a slip is the smallest amount that fails, not always 1', () => {
  // "At most 2 coffees" shown as a limit: a slip is three, the smallest count
  // that is over. It is the least the app can claim on the user's behalf, and
  // the day editor still takes the exact number.
  const limit = { ...avoidHabit, target_value: 2 };
  assert.equal(valueForState(limit, 'no'), 3);
  assert.equal(valueForState(limit, 'done'), 0);
});

test('the rendering only applies where there is something to avoid', () => {
  // `show_as` is kept when a habit's goal is switched to At least, so that
  // switching back does not lose it — which means the predicate, not the
  // stored value, is what stops it applying in between.
  assert.equal(isAvoided(avoidHabit), true);
  assert.equal(isAvoided({ ...avoidHabit, target_type: 'at_least' }), false);
  assert.equal(isAvoided({ ...avoidHabit, show_as: 'amount' }), false);
  assert.equal(isAvoided({}), false);
  assert.equal(isAvoided(undefined), false);
  // And an at-least habit still records the ordinary way.
  const flipped = { ...avoidHabit, target_type: 'at_least' };
  assert.equal(valueForState(flipped, 'done'), values.YES);
});

test('only a MEASURABLE at-most habit is avoided', () => {
  // The trap a review found, and it is reachable from the habit form in one
  // sitting: create a measurable at-most habit, choose "something to avoid",
  // then switch it to Yes / no and save. `show_as` is submitted regardless — so
  // that switching back does not lose it — and the stored habit is
  // boolean + at_most + avoid.
  //
  // Asking only two of the three questions then encoded a tap meaning DONE as
  // 0, and `isCompleted` reads 0 on a boolean habit as NOT done. The day
  // painted as a slip, the next tap recomputed the same state, and no sequence
  // of taps could ever mark it done.
  const trap = { type: 'boolean', target_type: 'at_most', target_value: 0, show_as: 'avoid' };
  assert.equal(isAvoided(trap), false);
  assert.equal(valueForState(trap, 'done'), values.YES,
    'a yes/no habit must record YES for a tap meaning done, whatever show_as says');
  assert.equal(valueForState(trap, 'no'), values.UNSET);
});
