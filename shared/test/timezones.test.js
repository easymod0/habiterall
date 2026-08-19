/**
 * Sweep `dateRange`'s DST literals in `stats.test.js`, and the year-boundary
 * streak literal in `streaks.test.js`, under six real timezones.
 *
 * A DST bug is invisible in the developer's own zone in exactly the way a
 * non-Gregorian calendar is invisible in en-US (`locales.mjs`): the literals
 * in both files hold in the repo's own zone whether `dateRange` walks by
 * `setDate` or by an epoch `+= 86400000` (Decision 3 in the brief) — only a
 * fall-back transition, actually observed, tells the two apart. `TZ` is read
 * once when the process starts, so nothing short of a fresh process observes
 * a changed zone; `parseInCappedChild` in `import.test.js` is the precedent
 * for spawning one from inside a unit test, for the same reason — the thing
 * being pinned lives in process state Node reads exactly once.
 *
 * Each zone below is listed for a PROPERTY, not for coverage — matching
 * `locales.mjs`'s table. Six zones, not an exhaustive sweep of the tzdb.
 *
 *   node --test test/timezones.test.js       (from shared/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const sharedRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * This file is itself run under `node --test`, which sets `NODE_TEST_CONTEXT`
 * (and `NODE_TEST_WORKER_ID`) in its own `process.env` to recognise its own
 * worker processes. Left in a spawned child's env, Node's test runner reads
 * them as "this is a nested worker" and silently skips running the files it
 * was given instead of erroring — so every canary check below would fail for
 * a reason that has nothing to do with the fix. Strip both before handing
 * `process.env` down.
 */
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

/**
 * The two files that carry the literals under test, named explicitly rather
 * than globbed. `test/**\/*.test.js` would also match this file, and a child
 * that re-globbed would spawn a grandchild that swept itself — recursing
 * forever. This list is the whole reason that can't happen.
 */
const SWEPT_FILES = ['test/stats.test.js', 'test/streaks.test.js'];

/**
 * The three canary test names whose presence, as an `ok` line in the child's
 * TAP output, is what each zone test actually checks. Two from stats.test.js
 * (the DST case that bites, and the one 30-minute-shift zone tests it under)
 * and one from streaks.test.js, so between them a passing zone test proves
 * BOTH swept files ran and neither canary was renamed or deleted out from
 * under this sweep.
 */
const CANARIES = [
  'dateRange across US fall back',
  "dateRange across Lord Howe's 30-minute DST transition",
  'a streak spanning a year boundary keeps both dates',
];

/**
 * Runs `SWEPT_FILES` under `TZ=zone` in a child process and returns its exit
 * code and raw TAP output, never throwing — a non-zero exit is a result to
 * assert on, not a test-runner failure to report as one.
 */
async function runSwept(zone, files = SWEPT_FILES) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--test', '--test-reporter=tap', ...files],
      { cwd: sharedRoot, env: childEnv({ TZ: zone }), maxBuffer: 1 << 20 }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

/**
 * Asserts the child exited clean AND that every canary shows as `ok <n> -
 * <name>` in its TAP output.
 *
 * Deliberately NOT a check on `# pass`: measured on Node 26.7.0, `node --test`
 * counts a file with zero `test()` calls as one implicit passing subtest, so
 * an emptied suite still reports `# pass 1` and exits 0 — a counter that can
 * never be zero for a file that loads is not a check at all. Naming each
 * canary is what a dropped file or a renamed test can actually fail.
 */
function assertCanaries(zone, result) {
  assert.equal(result.code, 0,
    `child under TZ=${zone} exited ${result.code}\nstderr:\n${result.stderr}`);
  for (const name of CANARIES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = new RegExp(`^ok \\d+ - ${escaped}$`, 'm');
    assert.ok(line.test(result.stdout),
      `TZ=${zone}: missing canary "${name}"\nstderr:\n${result.stderr}`);
  }
}

const ZONES = [
  ['UTC', 'the baseline — no DST at all'],
  ['America/New_York', 'northern DST; the fall-back case that kills an epoch walk'],
  ['Australia/Lord_Howe', 'southern DST AND a 30-minute shift'],
  ['Pacific/Chatham', 'a 45-minute offset that also observes DST'],
  ['Asia/Kathmandu', 'a 45-minute offset with no DST'],
  ['Pacific/Apia', "deleted 2011-12-30 from its calendar outright"],
];

for (const [zone, why] of ZONES) {
  test(`dateRange and computeStreaks literals hold under TZ=${zone} (${why})`, async () => {
    assertCanaries(zone, await runSwept(zone));
  });
}

/**
 * Not a mutation-killer — a correctness pin, so it stands apart from the
 * sweep above. `2011-12-30` never occurred in Samoa: the country moved to the
 * other side of the international date line and its calendar goes straight
 * from the 29th to the 31st. `dateRange`'s walk must OMIT that day rather
 * than merely tolerate it existing, and nothing in the six zone tests above
 * can see a regression here — none of them run under this zone with this
 * date pair.
 */
test('dateRange omits the day Pacific/Apia deleted from its calendar', async () => {
  const src = new URL('../src/stats.js', import.meta.url).href;
  const script = `
    const { dateRange } = await import(${JSON.stringify(src)});
    console.log(JSON.stringify(dateRange('2011-12-28', '2012-01-02')));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: sharedRoot, env: childEnv({ TZ: 'Pacific/Apia' }), maxBuffer: 1 << 20 }
  );
  const days = JSON.parse(stdout.trim());
  // Asserted as the whole list rather than as `!days.includes('2011-12-30')`:
  // the negative alone is satisfied by an empty array, so a `dateRange` that
  // returned nothing at all would pass the very check meant to prove it walks
  // the calendar correctly.
  assert.deepEqual(days,
    ['2011-12-28', '2011-12-29', '2011-12-31', '2012-01-01', '2012-01-02']);
});

/**
 * The mirror image of the case above, and the only one that can make the walk
 * run PAST its own end date.
 *
 * `n` counts elapsed 24-hour spans while the loop takes calendar steps. A zone
 * that moved the date line WESTWARD lived one local calendar day twice, so the
 * loop takes a step the elapsed count never saw and lands a day beyond `end` —
 * measured under Pacific/Kwajalein across its 1969 transition, 32 elements
 * ending 1969-10-02 for a range asked to stop on 1969-10-01. A deleted day (the
 * Apia case) needs no counterpart, because there the elapsed count shrinks
 * along with the calendar.
 *
 * The PREMISE is asserted rather than assumed, and that is not ceremony here.
 * `last === '1969-10-01'` and `len === 31` are also exactly what an ORDINARY
 * range produces, so on a machine where this zone does not resolve — a
 * stripped tzdata, a small-icu build — Node falls back silently and the whole
 * test passes with the trim deleted. `daysBetween` answering 31 across a
 * 30-step calendar span IS the repeated day, and it answers 30 under UTC, so
 * checking it first means a runner that cannot see the property fails loudly
 * instead of going quietly green. The Apia test above gets this for free from
 * its literal list; this one has to ask.
 */
test('dateRange never runs past end in a zone that lived a day twice', async () => {
  const src = new URL('../src/stats.js', import.meta.url).href;
  const script = `
    const { dateRange, daysBetween } = await import(${JSON.stringify(src)});
    const days = dateRange('1969-09-01', '1969-10-01');
    console.log(JSON.stringify({
      elapsed: daysBetween('1969-09-01', '1969-10-01'),
      last: days[days.length - 1],
      len: days.length,
    }));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: sharedRoot, env: childEnv({ TZ: 'Pacific/Kwajalein' }), maxBuffer: 1 << 20 }
  );
  const { elapsed, last, len } = JSON.parse(stdout.trim());

  assert.equal(elapsed, 31,
    `Pacific/Kwajalein did not resolve to a zone that lived 1969-09-30 twice `
    + `(elapsed ${elapsed}, expected 31) — this machine's tzdata cannot see `
    + 'the property under test, so the assertions below would pass vacuously');

  assert.equal(last, '1969-10-01', `walk ended on ${last}, past the end it was given`);
  assert.equal(len, 31);
});
