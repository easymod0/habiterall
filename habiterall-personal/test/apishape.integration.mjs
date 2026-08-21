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
// The clamp this suite fills to has to be the one the API enforces, not a
// restated 30 that could drift from it.
import { LIMITS } from '@habiterall/shared/validate.js';

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

/**
 * Categories — a habit's group, and the field that carries it.
 *
 * `category_id` on a fresh habit must be JSON null and not merely falsy: a
 * typed client (Api.kt's `Long?`) distinguishes null from 0, and 0 would be a
 * category whose id is 0 rather than "no category at all".
 */
async function postJson(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function putJson(path, body) {
  return fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const freshHabit = await makeHabit({ name: 'Category shape check', type: 'boolean' });
ck("a fresh habit's category_id is JSON null, not merely falsy",
  Object.is(freshHabit.category_id, null), JSON.stringify(freshHabit.category_id));

/* ---- create / list / rename / recolour / delete a category ---- */

const health = await (await postJson('/api/categories',
  { name: 'Health', color: '#ff0000' })).json();
ck('POST /categories creates it, with the name and colour sent',
  health.name === 'Health' && health.color === '#ff0000', JSON.stringify(health));

const listedCategories = await (await fetch(`${base}/api/categories`)).json();
ck('GET /categories lists it', listedCategories.some((c) => c.id === health.id));

const renamedAndRecoloured = await (await putJson(`/api/categories/${health.id}`,
  { name: 'Wellness', color: '#00ff00' })).json();
ck('PUT /categories/:id renames and recolours',
  renamedAndRecoloured.name === 'Wellness' && renamedAndRecoloured.color === '#00ff00',
  JSON.stringify(renamedAndRecoloured));

/* ---- fix round item 4: the URL id's SHAPE answers before its EXISTENCE,
 * in both editions, on the two category routes that take one ---- */

const putBadShape = await putJson('/api/categories/abc', { name: 'x' });
ck('PUT /categories/abc (not a number) is 400, not a 404 from Number(NaN)',
  putBadShape.status === 400, String(putBadShape.status));
const deleteBadShape = await fetch(`${base}/api/categories/abc`, { method: 'DELETE' });
ck('DELETE /categories/abc is 400 too',
  deleteBadShape.status === 400, String(deleteBadShape.status));

const putMissing = await putJson('/api/categories/999999', { name: 'x' });
ck('PUT /categories/999999 (well-shaped, absent) is 404',
  putMissing.status === 404, String(putMissing.status));
const deleteMissing = await fetch(`${base}/api/categories/999999`, { method: 'DELETE' });
ck('DELETE /categories/999999 is 404 too',
  deleteMissing.status === 404, String(deleteMissing.status));

/* ---- a category_id that shapes correctly but names nothing is a 400 ---- */

const noSuchCategory = 999999;
const postWithBadCategory = await postJson('/api/habits',
  { name: 'Bad category on create', type: 'boolean', category_id: noSuchCategory });
ck('POST /habits with a nonexistent category_id is 400',
  postWithBadCategory.status === 400, String(postWithBadCategory.status));

const habitToRecategorise = await makeHabit({ name: 'Recategorise me', type: 'boolean' });
const putWithBadCategory = await putJson(`/api/habits/${habitToRecategorise.id}`,
  { name: 'Recategorise me', type: 'boolean', category_id: noSuchCategory });
ck('PUT /habits/:id with a nonexistent category_id is 400',
  putWithBadCategory.status === 400, String(putWithBadCategory.status));

/* ---- a duplicate name, folded, is a 409 ---- */

const caseFoldedDuplicate = await postJson('/api/categories', { name: 'wellness' });
ck("a second category differing from 'Wellness' only by case is 409",
  caseFoldedDuplicate.status === 409, String(caseFoldedDuplicate.status));

/* ---- fix round 2, item 3: the fold is unpinned through HTTP unless a
 * NON-ASCII pair is asked, not only the ASCII one above ----
 *
 * 'Wellness' vs 'wellness' differs only by ASCII letter case, which SQLite's
 * own `NOCASE` collation already folds — so that assertion alone stayed
 * green with `categoryNameTaken` deleted from the route entirely, because the
 * DB constraint answered the 409 on its own and nothing here could tell the
 * two apart. 'Élan' vs 'élan' differs by a NON-ASCII letter (É/é, outside
 * NOCASE's ASCII range), so NOCASE treats them as two different names and
 * the INSERT would simply succeed — this pair can only ever be caught by the
 * route's own `categoryNameTaken`, which folds through `foldCategoryName`,
 * the one rule both editions ask instead so cloud's Postgres `lower()` and
 * this edition agree about it. Losing that call is silent on the ASCII case
 * and loud only here, which is why both stay in the suite.
 */
const elanRes = await postJson('/api/categories', { name: 'Élan', color: '#333333' });
ck("POST /categories creates 'Élan'", elanRes.status === 201, String(elanRes.status));
const elan = await elanRes.json();
const elanFoldedRes = await postJson('/api/categories', { name: 'élan', color: '#444444' });
ck("THE assertion: 'élan' after 'Élan' is 409 — NOCASE alone would let this " +
  'pair through, so this can only be caught by the route\'s own ' +
  'categoryNameTaken/foldCategoryName check',
  elanFoldedRes.status === 409, String(elanFoldedRes.status));
await fetch(`${base}/api/categories/${elan.id}`, { method: 'DELETE' });

/* ---- fix round item 2(b): a unique-constraint violation the route's own
 * check misses is a 409, not a 500 ----
 *
 * Doing this "with the fold deliberately bypassed" means the ROUTE's own
 * `categoryNameTaken` must say "not taken" while the INSERT still collides —
 * and, having fixed item 2(a), that pairing is no longer reachable through
 * any HTTP request: `foldCategoryName` is now plain `toLowerCase()`, and
 * SQLite's `NOCASE` collation can only ever call two strings equal when they
 * differ by ASCII letter case alone, which `toLowerCase()` always agrees on
 * regardless of host locale. Two names the route's own check would ever MISS
 * are therefore also two names `NOCASE` would never collide on — which is
 * this fix working, not a gap in it. The only way left to reach the
 * constraint is to bypass the route's check entirely, exactly as a genuine
 * race between two concurrent requests would (unreachable here too: every
 * handler in this edition is synchronous end to end, so nothing can
 * interleave between the check and the INSERT within one process — the race
 * this backstop also exists for is real on the cloud edition's async routes,
 * not this one). So this drives the actual SQLite constraint directly,
 * through the same `db` this running server has open, and asserts the
 * MAPPING this item added — `isCategoryNameConflict` — is what a route
 * hitting this now-otherwise-unreachable case would answer with.
 */
const { db: liveDb, isCategoryNameConflict } = await import('../src/db.js');
liveDb.prepare(`INSERT INTO categories (name, color, position) VALUES (?, ?, 0)`)
  .run('Zzz Race Category', '#111111');
let raceErr = null;
try {
  liveDb.prepare(`INSERT INTO categories (name, color, position) VALUES (?, ?, 0)`)
    .run('zzz race category', '#222222');
} catch (e) { raceErr = e; }
ck('the DB constraint itself fires for a byte-identical NOCASE duplicate',
  raceErr !== null, String(raceErr));
ck('and isCategoryNameConflict recognises it — this is the mapping the ' +
  'route\'s try/catch calls to answer 409 instead of the constraint\'s own 500',
  !!raceErr && isCategoryNameConflict(raceErr), String(raceErr?.message));
ck('…and does not mistake an unrelated constraint for this one',
  !isCategoryNameConflict(new Error('NOT NULL constraint failed: habits.name')));
// Clean up the row inserted straight through `db`, bypassing the route.
await fetch(`${base}/api/categories`).then((r) => r.json()).then((cats) =>
  Promise.all(cats.filter((c) => c.name === 'Zzz Race Category')
    .map((c) => fetch(`${base}/api/categories/${c.id}`, { method: 'DELETE' }))));

/* ---- deleting a category leaves its habits and their entries alone ---- */

const toDelete = await (await postJson('/api/categories', { name: 'ToDelete' })).json();
const habitWithCategory = await makeHabit(
  { name: 'Read', type: 'boolean', category_id: toDelete.id }
);
ck('a habit created with a category_id keeps it',
  habitWithCategory.category_id === toDelete.id, JSON.stringify(habitWithCategory.category_id));

await fetch(`${base}/api/habits/${habitWithCategory.id}/entries/2026-01-01`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 2 }),
});

const deleteCategoryResp = await fetch(`${base}/api/categories/${toDelete.id}`,
  { method: 'DELETE' });
ck('DELETE /categories/:id succeeds',
  deleteCategoryResp.status === 204, String(deleteCategoryResp.status));

const survivingHabit = await (await fetch(`${base}/api/habits/${habitWithCategory.id}`)).json();
ck("the habit survives its category's deletion, and comes back uncategorised",
  Object.is(survivingHabit.category_id, null), JSON.stringify(survivingHabit.category_id));

const survivingEntries = await (
  await fetch(`${base}/api/habits/${habitWithCategory.id}/entries`)
).json();
ck('every one of its entries survives the deletion too',
  survivingEntries.length === 1, JSON.stringify(survivingEntries));

/* ---- PUT /habits/:id replaces: omitting category_id clears it ---- */

const secondCategory = await (await postJson('/api/categories', { name: 'Second' })).json();
const habitToClear = await makeHabit(
  { name: 'Clear me', type: 'boolean', category_id: secondCategory.id }
);
ck('created with a category_id, it is set',
  habitToClear.category_id === secondCategory.id, JSON.stringify(habitToClear.category_id));

const clearedByOmission = await (await putJson(`/api/habits/${habitToClear.id}`,
  { name: 'Clear me', type: 'boolean' })).json();
ck('a PUT that omits category_id clears it (the replace rule)',
  Object.is(clearedByOmission.category_id, null), JSON.stringify(clearedByOmission.category_id));

const habitToKeep = await makeHabit(
  { name: 'Keep me', type: 'boolean', category_id: secondCategory.id }
);
const keptByCarrying = await (await putJson(`/api/habits/${habitToKeep.id}`,
  { name: 'Keep me', type: 'boolean', category_id: secondCategory.id })).json();
ck('a PUT that carries category_id keeps it',
  keptByCarrying.category_id === secondCategory.id, JSON.stringify(keptByCarrying.category_id));

/* ---- LIMITS.categories is a ceiling, not a suggestion ----
 * Last, deliberately: it fills the account to the ceiling, and every test
 * above that creates a category needs room left to do it in. */

const categoryCountBefore = (await (await fetch(`${base}/api/categories`)).json()).length;
let filledToCeiling = true;
for (let i = categoryCountBefore; i < LIMITS.categories; i++) {
  const r = await postJson('/api/categories', { name: `Filler ${i}` });
  if (r.status !== 201) { filledToCeiling = false; break; }
}
ck(`this account can be filled to LIMITS.categories (${LIMITS.categories})`, filledToCeiling);

const overCeiling = await postJson('/api/categories', { name: 'One too many' });
ck('a category past LIMITS.categories gives 400',
  overCeiling.status === 400, String(overCeiling.status));

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'all API shape checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
