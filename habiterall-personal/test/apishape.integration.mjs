/**
 * The habit JSON shape, as native clients see it.
 *
 * The Android client declares a strongly-typed `Habit` and refuses to
 * deserialise anything else. SQLite has no boolean type, so `archived` came
 * back as 0 while the cloud edition's Postgres BOOLEAN returned true — the
 * same endpoint describing the same habit with two different JSON types.
 *
 * The web UI survived it (0 and false are both falsy) so nothing caught it
 * until a real phone said:
 *
 *   Expected valid boolean literal prefix, but had '0'
 *
 *   node test/apishape.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-shape-'));
// These suites exercise the API, not sign-in or rate limiting, and auth now
// defaults ON — see shared/src/password.js. Both are turned off explicitly here,
// before the server module is imported, exactly as HABITERALL_DB must be: a
// suite that writes a few hundred entries in a burst is what the 300/minute API
// limit is meant to catch, and here that burst is the point.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'shape.db');

const { app } = await import('../src/server.js');
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/**
 * What a typed client expects. Mirrors `Habit` in
 * android-native/app/src/main/java/com/habiterall/app/data/Api.kt — if you
 * change one, change the other.
 */
const HABIT_TYPES = {
  id: 'number',
  name: 'string',
  description: 'string',
  type: 'string',
  unit: 'string',
  target_value: 'number',
  target_type: 'string',
  freq_numerator: 'number',
  freq_denominator: 'number',
  color: 'string',
  reminder_time: 'string',
  // The three that were in Kotlin's `Habit` and not here. Every one of them
  // has a Kotlin default, so kotlinx substitutes it in silence when the server
  // omits the field — the "a field at its default everywhere compares equal to
  // itself" failure, one layer out, on the client this suite exists for.
  // Measured: deleting all three from every habit response left this suite
  // green.
  reminder_message: 'string',
  at_most_unlogged: 'string',
  show_as: 'string',
  icon: 'string',
  position: 'number',
  archived: 'boolean',
};

const checkShape = (label, habit) => {
  const wrong = Object.entries(HABIT_TYPES)
    .filter(([k, t]) => typeof habit[k] !== t)
    .map(([k, t]) => `${k}: expected ${t}, got ${typeof habit[k]} (${JSON.stringify(habit[k])})`);
  ck(`${label}: every field matches the typed-client contract`,
    wrong.length === 0, wrong.join('; '));
};

const created = await (await fetch(`${base}/api/habits`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Shape', type: 'boolean' }),
})).json();

checkShape('POST /habits', created);

const list = await (await fetch(`${base}/api/habits`)).json();
checkShape('GET /habits', list[0]);

const one = await (await fetch(`${base}/api/habits/${created.id}`)).json();
checkShape('GET /habits/:id', one);

const updated = await (await fetch(`${base}/api/habits/${created.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Shape', type: 'boolean', archived: true }),
})).json();
checkShape('PUT /habits/:id', updated);
ck('an archived habit reports archived: true',
  updated.archived === true, JSON.stringify(updated.archived));

// Assert the habit is there rather than guarding on it: a route that regressed
// to zero habits would DELETE the check below rather than fail it.
const overview = await (await fetch(`${base}/api/overview?days=7&archived=true`)).json();
ck('GET /overview returned the habit', overview.habits.length > 0);
if (overview.habits.length) checkShape('GET /overview', overview.habits[0]);

const exported = await (await fetch(`${base}/api/export`)).json();
ck('GET /export returned the habit', exported.habits.length > 0);
if (exported.habits.length) checkShape('GET /export', exported.habits[0]);

/**
 * `unlogged_is_success` — the flag `unansweredCounts` resolves onto the
 * response, checked at both call sites (`/overview`, `/stats`). Its own unit
 * tests pin the precedence rule; this is the wiring, which is exactly what a
 * caller can get wrong without touching the rule at all. Every habit here
 * carries no entries, so every day is unanswered on purpose.
 */
async function putSettings(patch) {
  await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function makeHabit(body) {
  return (await (await fetch(`${base}/api/habits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json());
}

async function overviewFlag(id) {
  const body = await (await fetch(`${base}/api/overview?days=7`)).json();
  return body.habits.find((h) => h.id === id)?.unlogged_is_success;
}

async function statsFlag(id) {
  const body = await (await fetch(`${base}/api/habits/${id}/stats`)).json();
  return body.habit.unlogged_is_success;
}

/**
 * Assert a real JSON boolean, not merely a truthy or falsy value — a wrong
 * implementation that echoes the raw setting string ("success"/"miss") would
 * pass a `== expected` check on every row here.
 */
function ckFlag(label, id, expected) {
  return Promise.all([
    overviewFlag(id).then((v) => ck(`${label} (/overview)`, v === expected,
      `got ${JSON.stringify(v)} (${typeof v})`)),
    statsFlag(id).then((v) => ck(`${label} (/stats)`, v === expected,
      `got ${JSON.stringify(v)} (${typeof v})`)),
  ]);
}

await putSettings({ atMostUnlogged: 'success' });

const numericalAtMostDefault = await makeHabit({
  name: 'Soda (default)', type: 'numerical', target_type: 'at_most', target_value: 2,
});
await ckFlag('account success, habit default, numerical at-most -> true',
  numericalAtMostDefault.id, true);

const booleanHabit = await makeHabit({ name: 'Meditate', type: 'boolean' });
await ckFlag('account success, habit default, boolean -> false', booleanHabit.id, false);

const numericalAtLeast = await makeHabit({
  name: 'Pushups', type: 'numerical', target_type: 'at_least', target_value: 20,
});
await ckFlag('account success, habit default, numerical at-least -> false',
  numericalAtLeast.id, false);

await putSettings({ atMostUnlogged: 'miss' });

const habitOverridesSuccess = await makeHabit({
  name: 'Soda (override success)', type: 'numerical', target_type: 'at_most',
  target_value: 2, at_most_unlogged: 'success',
});
await ckFlag('account miss, habit success, numerical at-most -> true',
  habitOverridesSuccess.id, true);

await putSettings({ atMostUnlogged: 'success' });

const habitOverridesMiss = await makeHabit({
  name: 'Soda (override miss)', type: 'numerical', target_type: 'at_most',
  target_value: 2, at_most_unlogged: 'miss',
});
await ckFlag('account success, habit miss, numerical at-most -> false',
  habitOverridesMiss.id, false);

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'all API shape checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
