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
// Dates only. `/categories/stats`'s own ceiling is asserted as the LITERAL
// 1830 below and deliberately not imported: a test that imports the constant it
// checks pins the name and nothing else — the `fresh` window passed with 7
// widened to 30 while its own comment claimed the boundary was covered.
import { today, addDays } from '@habiterall/shared/stats.js';

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
 * `checkShape` above iterates a typed SUBSET, so an extra column — the
 * summary-cache fields, `best_streak`/`total_completed`/`summary_asof`
 * (#184), or anything else added later that forgets `stripSummaryCache` or
 * `toApiHabit` — passes it silently. This is the exact-key tripwire cloud
 * already has (`PORTABLE_HABIT_KEYS`, habiterall-cloud/test/api.integration.mjs)
 * for its own `/export`, mirrored here so a leak on EITHER edition's backup
 * fails a suite. Cloud's own comment says this needs a list both editions
 * assert against to close the gap for good; until then, two copies of the
 * same literal are strictly better than the one edition this used to cover.
 */
const PORTABLE_HABIT_KEYS = [
  'archived', 'at_most_unlogged', 'category', 'category_id', 'color', 'created_at',
  'description', 'entries', 'freq_denominator', 'freq_numerator', 'icon', 'id', 'name',
  'position', 'reminder_message', 'reminder_time', 'show_as', 'target_type',
  'target_value', 'type', 'unit',
];
ck('THE assertion: GET /export describes a habit with EXACTLY these keys, ' +
  'not one more — the tripwire for best_streak/total_completed/summary_asof',
  JSON.stringify(Object.keys(exported.habits[0] ?? {}).sort())
    === JSON.stringify(PORTABLE_HABIT_KEYS),
  Object.keys(exported.habits[0] ?? {}).sort().join(','));

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

/* ---- ...and so does every id in the list `POST /categories/reorder` takes.
 * Cloud asks `Number.isInteger` of each; this edition asked
 * `Number.isFinite`, so `[1.5]` was a 400 there and a 200 here — and a 200
 * that moved nothing, because `setCategoryPosition` matches no row for a
 * fractional id. A reorder that reports success and applies to nothing is
 * exactly the failure a client cannot see, and this was the one category
 * route left out of the shape-before-existence alignment above. ---- */

const reorderFraction = await postJson('/api/categories/reorder', { order: [1.5] });
ck('POST /categories/reorder with a fractional id is 400, the same as in cloud',
  reorderFraction.status === 400, String(reorderFraction.status));

const reorderText = await postJson('/api/categories/reorder', { order: ['abc'] });
ck('...and a non-numeric one is 400 too',
  reorderText.status === 400, String(reorderText.status));

// A no-op reorder: the account's own ids, in the order it already has them,
// so this asserts the guard above still lets a real request through without
// moving anything the assertions below read.
const currentOrder = (await (await fetch(`${base}/api/categories`)).json()).map((c) => c.id);
const reorderOk = await postJson('/api/categories/reorder', { order: currentOrder });
ck('a well-shaped reorder still succeeds',
  reorderOk.status === 200, String(reorderOk.status));

/* ---- ...and so is an entry that merely COERCES to an id.
 *
 * `Number.isInteger(Number(n))` — what both editions asked after the
 * fractional-id fix above — answers YES to `null`, `''` and `[]` (all 0) and
 * to `true` (1). Neither is a rejected value that happens to be harmless:
 * id 0 matches no row, so the request answered 200 having moved nothing, and
 * id 1 is a real row in this account, so `[true]` MOVED a category nobody
 * named. `parseCategoryId` (shared/src/validate.js) is the shape rule now,
 * the same one `/categories/:id` asks of the URL.
 *
 * The status is only half of it — a 400 proves the guard fired, not that the
 * table is untouched — so the list is put in a deliberate order first and
 * compared afterwards. Two extra categories exist for that: with one row the
 * "before" and "after" orders are equal whatever the route does, which is a
 * check that cannot fail. ---- */

const reorderA = await (await postJson('/api/categories', { name: 'Zzz Reorder A' })).json();
const reorderB = await (await postJson('/api/categories', { name: 'Zzz Reorder B' })).json();
const ids = (await (await fetch(`${base}/api/categories`)).json()).map((c) => c.id);
await postJson('/api/categories/reorder', { order: [...ids].reverse() });
const pinned = (await (await fetch(`${base}/api/categories`)).json()).map((c) => c.id);
ck('sanity: the account is in a deliberate order, and id 1 is no longer first',
  pinned.length >= 3 && pinned.includes(1) && pinned[0] !== 1, JSON.stringify(pinned));

const reorderBool = await postJson('/api/categories/reorder', { order: [true] });
ck('POST /categories/reorder with `true` is 400 — Number(true) is 1, a real id here',
  reorderBool.status === 400, String(reorderBool.status));

const reorderNull = await postJson('/api/categories/reorder', { order: [null] });
ck('...and `null` is 400 — Number(null) is 0, which matched no row and answered 200',
  reorderNull.status === 400, String(reorderNull.status));

const reorderEmptyString = await postJson('/api/categories/reorder', { order: [''] });
ck("...and '' is 400 too", reorderEmptyString.status === 400, String(reorderEmptyString.status));

const afterRefusals = (await (await fetch(`${base}/api/categories`)).json()).map((c) => c.id);
ck('THE assertion: not one of the three refused requests moved a category',
  JSON.stringify(afterRefusals) === JSON.stringify(pinned),
  JSON.stringify({ pinned, afterRefusals }));

// Put the account back the way this block found it, so the ceiling test below
// counts what it expects to.
for (const id of [reorderA.id, reorderB.id]) {
  await fetch(`${base}/api/categories/${id}`, { method: 'DELETE' });
}
await postJson('/api/categories/reorder', { order: currentOrder });

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

/* ---- issue #256: İstanbul / Istanbul is the same bug as Élan / élan above,
 * and it is the one the issue was filed about — `.toLowerCase()` maps U+0130
 * ('İ') to 'i' + a combining dot (U+0307), never to plain 'i', so the OLD
 * fold disagreed with cloud's Postgres `lower()`, which collapses both to
 * 'i'. Before the fix this edition's own NOCASE backstop cannot see the
 * difference either (İ is outside NOCASE's ASCII range), so a route with the
 * old fold let a second 'İstanbul' row through here where cloud's DB
 * constraint would have refused it outright. This block pins the ROUTE and
 * the IMPORTER, not the fold itself — that is `shared/test/validate.test.js`
 * — because a fold being right does not make its two callers use it.
 *
 * Every literal below is a literal NAME comparison, deliberately never a call
 * to `foldCategoryName` — asserting `foldCategoryName(a) === foldCategoryName(b)`
 * would test the function against itself and pass unchanged even with the
 * fold reverted to plain `.toLowerCase()`, which is exactly the trap this
 * suite's own header names.
 */
const istanbulRes = await postJson('/api/categories', { name: 'Istanbul', color: '#111111' });
ck("POST /categories creates 'Istanbul'", istanbulRes.status === 201, String(istanbulRes.status));
const istanbul = await istanbulRes.json();

const dotlessIstanbulRes = await postJson('/api/categories', { name: 'İstanbul' });
ck("THE assertion: 'İstanbul' (U+0130) after 'Istanbul' is 409 — today this " +
  'edition answers 201 (two categories) because the old fold and NOCASE both ' +
  'miss this pair; cloud already answers 409 from its lower()-backed index',
  dotlessIstanbulRes.status === 409, String(dotlessIstanbulRes.status));

// A merge-mode import of a backup that declares 'İstanbul' as a CATEGORY (with
// a colour that is deliberately NOT DEFAULT_COLOR — a fixture carrying the
// default would still pass with the never-recolour rule deleted) and a habit
// naming it. `entries: []` because this block is about category resolution,
// not entry fidelity.
const importBackup = Buffer.from(JSON.stringify({
  categories: [{ name: 'İstanbul', color: '#abcdef' }],
  habits: [{
    name: 'issue-256 imported habit', type: 'boolean', category: 'İstanbul', entries: [],
  }],
}));
const importRes = await fetch(`${base}/api/import?mode=merge`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: importBackup,
});
ck('the İstanbul import itself succeeds', importRes.status === 200, String(importRes.status));
const importResult = await importRes.json();
ck('…and records no skip — today this edition\'s own NOCASE backstop never ' +
  'fires here (İ is outside its ASCII range), so nothing is skipped either way; ' +
  'this is the parallel assertion to cloud\'s below, where a skip IS the ' +
  "divergence",
  Array.isArray(importResult.skipped) && importResult.skipped.length === 0,
  JSON.stringify(importResult.skipped));

const categoriesAfterImport = await (await fetch(`${base}/api/categories`)).json();
const matchingIstanbul = categoriesAfterImport
  .filter((c) => c.name === 'Istanbul' || c.name === 'İstanbul');
ck('THE assertion: still exactly ONE category named either spelling — today ' +
  "this edition's NOCASE backstop lets the import's İstanbul spelling create " +
  'a second row',
  matchingIstanbul.length === 1, JSON.stringify(categoriesAfterImport.map((c) => c.name)));

const importedHabits = await (await fetch(`${base}/api/habits`)).json();
const importedHabit = importedHabits.find((h) => h.name === 'issue-256 imported habit');
ck("THE assertion: the imported habit's category_id is the PRE-EXISTING " +
  "'Istanbul' row's id — asserting the ID and not merely the count, since a " +
  "second row could otherwise absorb the habit and still leave a count of one " +
  'if the pre-existing row were the one left duplicated instead',
  importedHabit?.category_id === istanbul.id,
  `${importedHabit?.category_id} vs ${istanbul.id} (categories named either spelling: ` +
    `${JSON.stringify(categoriesAfterImport.map((c) => ({ id: c.id, name: c.name })))})`);

const istanbulAfterImport = categoriesAfterImport.find((c) => c.id === istanbul.id);
ck('resolve-or-create must never recolour a category it found: the import\'s ' +
  "own colour (#abcdef, not DEFAULT_COLOR) must not have overwritten the " +
  "pre-existing row's #111111",
  istanbulAfterImport?.color === '#111111', JSON.stringify(istanbulAfterImport));

// Clean up everything this block created, by id — 'İstanbul' only exists as a
// row here when the fold is broken, so this is unconditional rather than
// assuming which rows are present.
if (importedHabit) await fetch(`${base}/api/habits/${importedHabit.id}`, { method: 'DELETE' });
for (const c of categoriesAfterImport) {
  if (c.name === 'Istanbul' || c.name === 'İstanbul') {
    await fetch(`${base}/api/categories/${c.id}`, { method: 'DELETE' });
  }
}

/* ---- issue #256 (review round): a replace-mode restore silently merges two
 * of the FILE's own categories, and nothing said so ----
 *
 * The block above is a MERGE importing one declared category that resolves
 * onto an account's pre-existing row — the headline case, and it must keep
 * recording NO skip; that is the whole point of this PR. This block is the
 * other shape: a SINGLE file declaring TWO categories, `Istanbul` and
 * `İstanbul`, that fold to the same name. The second one is not created —
 * `resolveOrCreateCategory` resolves it onto the first — and unlike the
 * headline case, this loss is information only the FILE has: two categories
 * the file itself declared came back as one, and before this fix nothing in
 * `result.skipped` said so.
 *
 * Different colours and a habit each, so a fixture carrying DEFAULT_COLOR or
 * no habits could not pass with the collapse-reporting rule deleted.
 */
const dupBackup = Buffer.from(JSON.stringify({
  categories: [
    { name: 'Istanbul', color: '#101010' },
    { name: 'İstanbul', color: '#202020' },
  ],
  habits: [
    { name: 'issue-256 dup habit A', type: 'boolean', category: 'Istanbul', entries: [] },
    { name: 'issue-256 dup habit B', type: 'boolean', category: 'İstanbul', entries: [] },
  ],
}));
const dupImportRes = await fetch(`${base}/api/import?mode=merge`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: dupBackup,
});
ck('the dup-category import itself succeeds',
  dupImportRes.status === 200, String(dupImportRes.status));
const dupImportResult = await dupImportRes.json();
ck(
  'THE assertion: the SECOND declared category (İstanbul, folding to the ' +
  "same name as the FIRST declared category, Istanbul) IS reported in " +
  "skipped — two categories the file itself declared collapsing to one is " +
  'information only the file has, unlike the headline merge-onto-existing case',
  Array.isArray(dupImportResult.skipped) &&
    dupImportResult.skipped.some((s) => s.includes('İstanbul')),
  JSON.stringify(dupImportResult.skipped));

const dupCategories = await (await fetch(`${base}/api/categories`)).json();
const dupMatching = dupCategories.filter((c) => c.name === 'Istanbul' || c.name === 'İstanbul');
ck('still exactly ONE category named either spelling after the dup import',
  dupMatching.length === 1, JSON.stringify(dupCategories.map((c) => c.name)));

const dupHabits = await (await fetch(`${base}/api/habits`)).json();
const dupHabitA = dupHabits.find((h) => h.name === 'issue-256 dup habit A');
const dupHabitB = dupHabits.find((h) => h.name === 'issue-256 dup habit B');
ck(
  "THE assertion: both habits' category_id is the SAME id — the FIRST " +
  "declared category's (Istanbul), never a second row",
  dupHabitA?.category_id != null &&
    dupHabitA.category_id === dupHabitB?.category_id &&
    dupHabitA.category_id === dupMatching[0]?.id,
  `A=${dupHabitA?.category_id} B=${dupHabitB?.category_id} ` +
    `kept=${JSON.stringify(dupMatching)}`);

// Clean up everything this block created.
for (const h of [dupHabitA, dupHabitB]) {
  if (h) await fetch(`${base}/api/habits/${h.id}`, { method: 'DELETE' });
}
for (const c of dupCategories) {
  if (c.name === 'Istanbul' || c.name === 'İstanbul') {
    await fetch(`${base}/api/categories/${c.id}`, { method: 'DELETE' });
  }
}

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

/* ---- GET /categories/stats — the three things only the ROUTE can get wrong ----
 *
 * `computeCategoryStats` has its own unit tests and they pin the arithmetic.
 * These pin the WIRING, which is what a route gets wrong without touching the
 * rule at all: what it hands the function, and what it refuses to compute.
 */

const STATS_END = today();
const STATS_START = addDays(STATS_END, -29);

const statsUrl = (params) =>
  `${base}/api/categories/stats?${new URLSearchParams(params)}`;

const categoryStats = async (params = {}) => (await (await fetch(statsUrl({
  start: STATS_START, end: STATS_END, granularity: 'day', ...params,
}))).json());

const logDay = (id, date) => fetch(`${base}/api/habits/${id}/entries/${date}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 2 }),
});

/* -- archived members: excluded from the category, and COUNTED -- */

const keptCategory = await (await postJson('/api/categories',
  { name: 'Compare Kept', color: '#123456' })).json();

const keptHabit = await makeHabit(
  { name: 'Compare Kept habit', type: 'boolean', category_id: keptCategory.id }
);
const archivedHabit = await makeHabit(
  { name: 'Compare Archived habit', type: 'boolean', category_id: keptCategory.id }
);
// Both logged, so the archived one has a real strength to be left out OF —
// a member sitting at no score would drop out of the mean either way.
for (let i = 0; i < 10; i++) {
  await logDay(keptHabit.id, addDays(STATS_END, -i));
  await logDay(archivedHabit.id, addDays(STATS_END, -i));
}

const beforeArchive = await categoryStats();
const keptBefore = beforeArchive.categories.find((c) => c.id === keptCategory.id);
ck('both members are counted while both are active',
  keptBefore?.members === 2, `members: ${keptBefore?.members}`);
ck('sanity: the window ends on the day that was asked for',
  beforeArchive.buckets.at(-1) === STATS_END,
  JSON.stringify({ last: beforeArchive.buckets.at(-1), STATS_END }));

const archivedCountBefore = beforeArchive.archivedExcluded;

await putJson(`/api/habits/${archivedHabit.id}`, {
  name: 'Compare Archived habit', type: 'boolean',
  category_id: keptCategory.id, archived: true,
});

const afterArchive = await categoryStats();
const keptAfter = afterArchive.categories.find((c) => c.id === keptCategory.id);
ck('an archived member leaves its category\'s member count',
  keptAfter?.members === 1, `members: ${keptAfter?.members}`);
ck('THE assertion: and it is COUNTED in archivedExcluded — a route that ' +
  'filtered on `archived` in SQL reports 0 here forever, and the view has ' +
  'nothing to say about what it left out',
  afterArchive.archivedExcluded === archivedCountBefore + 1,
  JSON.stringify({ archivedCountBefore, after: afterArchive.archivedExcluded }));
ck('...and the one active member is both the best and the worst named',
  keptAfter?.best?.id === keptHabit.id && keptAfter?.worst?.id === keptHabit.id,
  JSON.stringify({ best: keptAfter?.best, worst: keptAfter?.worst }));

/* -- an ABANDONED habit is in the mean; only a NEVER-LOGGED one is excluded --
 *
 * The route fetches entries from `start - 400`, so a habit last logged before
 * that comes back with an empty slice — indistinguishable, from the slice
 * alone, from one that has never been logged at all. They are different facts
 * and only one of them should keep a habit out of its category's mean: an
 * abandoned habit has a real strength near zero and really is dragging the
 * category down. The lifetime `MIN(date)` is what tells them apart, and this is
 * the only assertion in the suite that can see whether the route supplies it.
 */

const abandonedCategory = await (await postJson('/api/categories',
  { name: 'Compare Abandoned', color: '#654321' })).json();
const abandonedHabit = await makeHabit(
  { name: 'Compare Abandoned habit', type: 'boolean',
    category_id: abandonedCategory.id }
);
// 900 days back: well outside the fetched window (29 + 400 = 429 days), and
// well inside the lifetime the grouped MIN(date) reads.
for (let i = 0; i < 3; i++) {
  await logDay(abandonedHabit.id, addDays(STATS_END, -(900 + i)));
}

const neverCategory = await (await postJson('/api/categories',
  { name: 'Compare Never', color: '#abcdef' })).json();
await makeHabit(
  { name: 'Compare Never habit', type: 'boolean', category_id: neverCategory.id }
);

const landing = await categoryStats();
const abandoned = landing.categories.find((c) => c.id === abandonedCategory.id);
const never = landing.categories.find((c) => c.id === neverCategory.id);

ck('the abandoned habit is a member of its category',
  abandoned?.members === 1, `members: ${abandoned?.members}`);
ck('THE assertion: it is NOT reported as never logged — its entries are older ' +
  'than the fetched slice, so only a lifetime MIN(date) can say so',
  abandoned?.unloggedExcluded === 0,
  JSON.stringify({ unloggedExcluded: abandoned?.unloggedExcluded,
                   mean: abandoned?.mean }));
ck('...so it is averaged into the mean rather than left out of it',
  typeof abandoned?.mean === 'number', JSON.stringify(abandoned?.mean));

ck('a habit that has never been logged is counted, and counted as unlogged',
  never?.members === 1 && never?.unloggedExcluded === 1,
  JSON.stringify({ members: never?.members,
                   unloggedExcluded: never?.unloggedExcluded }));
ck('...and a category with nothing landed has no mean at all, never 0',
  Object.is(never?.mean, null), JSON.stringify(never?.mean));

ck('Uncategorised is the last section, and carries id null',
  Object.is(landing.categories.at(-1).id, null),
  JSON.stringify(landing.categories.at(-1)?.id));

/* -- the warm-up: this route agrees with the habit's OWN page --
 *
 * `computeScores` starts its EWMA at 0 on the first day of the range it is
 * handed, so a comparison computed cold at the requested `start` reports every
 * habit weaker than `/habits/:id/stats` does — `ui/detail.js` sends that route
 * no `start`, so a habit's own page is always converged from its first entry.
 * Two surfaces disagreeing about the same habit is indistinguishable from one
 * of them being broken, which is why each member is scored over
 * `[start - SCORE_WARMUP_DAYS, end]` and sliced back.
 *
 * `stats.test.js` pins that DECISION and cannot pin the WIRING: the pure
 * function scores whatever entries it is handed, so a route fetching from
 * `start` rather than from `start - SCORE_WARMUP_DAYS` satisfies every unit
 * test in this repo — the member simply arrives with a shorter history and
 * `computeCategoryStats` has no way to know it was short-changed. This is the
 * route-layer half, and the assertion is deliberately CROSS-SURFACE: the claim
 * the warm-up makes is not "400 days are fetched", it is "the comparison says
 * what the habit's own page says".
 *
 * It needs a SHORT window to be falsifiable at all. The default window is 365
 * days — some 28 half-lives of this decay — so a series starting cold at that
 * edge has re-converged long before `end` and the two figures agree whether or
 * not the warm-up is there. Twenty days is inside its reach.
 */

// Three times the window compared below, so the warm-up has real history to
// reach back for rather than a few days of it.
const WARMUP_HISTORY_DAYS = 60;
// Inclusive, so this is a 20-day window and not a 21-day one.
const WARMUP_START = addDays(STATS_END, -19);

const warmupCategory = await (await postJson('/api/categories',
  { name: 'Compare Warmup', color: '#0f766e' })).json();
const warmupHabit = await makeHabit(
  { name: 'Compare Warmup habit', type: 'boolean', category_id: warmupCategory.id }
);
for (let i = 0; i < WARMUP_HISTORY_DAYS; i++) {
  await logDay(warmupHabit.id, addDays(STATS_END, -i));
}

// The habit's own page, asked exactly as the detail view asks it: an `end`,
// and no `start` at all.
const ownPage = await (await fetch(
  `${base}/api/habits/${warmupHabit.id}/stats?end=${STATS_END}`)).json();
const ownScore = ownPage.scores?.at(-1)?.score;

// The control, and it is what makes the assertion below able to fail: the
// member's history must start well BEFORE the compared window opens. Against a
// habit first logged inside that window, a route with no warm-up produces the
// very same agreement, because there would be nothing earlier to miss.
ck('sanity: the member has history reaching far back beyond the compared window',
  ownPage.scores?.length === WARMUP_HISTORY_DAYS
    && WARMUP_HISTORY_DAYS > 20,
  JSON.stringify({ points: ownPage.scores?.length, WARMUP_HISTORY_DAYS }));

const shortWindow = await categoryStats({ start: WARMUP_START });
const warm = shortWindow.categories.find((c) => c.id === warmupCategory.id);

ck('sanity: that window really is the short one, 20 days of buckets',
  shortWindow.buckets.length === 20,
  JSON.stringify({ buckets: shortWindow.buckets.length, WARMUP_START }));
ck('sanity: and the category has exactly the one member being compared',
  warm?.members === 1 && warm?.unloggedExcluded === 0,
  JSON.stringify({ members: warm?.members, unlogged: warm?.unloggedExcluded }));

// Compared against the habit's own figure, never a literal: the number is a
// property of this fixture, and writing it out would pin the fixture rather
// than the agreement between the two surfaces.
ck('THE assertion: over a 20-day window the category mean IS the member\'s own ' +
  'strength — a route fetching entries from `start` instead of ' +
  '`start - SCORE_WARMUP_DAYS` reports it weaker here than its own page does',
  warm?.mean === ownScore && typeof ownScore === 'number',
  JSON.stringify({ mean: warm?.mean, ownScore }));
ck('...and the chart\'s last point is that same number, not a near-miss',
  warm?.series.at(-1)?.value === warm?.mean,
  JSON.stringify({ last: warm?.series.at(-1)?.value, mean: warm?.mean }));

/* -- ...and it agrees about an AVOID habit, which is the shape it can FLATTER --
 *
 * The block above covers the at-least shape, and that shape cannot see half of
 * this. The warm-up reaches back before the member existed, and on an at-least
 * habit those phantom days credit 0 — so the two surfaces agree whether or not
 * the range is clamped to the member's own first entry. On an at-most habit
 * whose unlogged days count as KEPT (`at_most_unlogged: 'success'`, or the
 * account's `atMostUnlogged`, which is every `show_as: 'avoid'` habit under that
 * setting) an unlogged day is FULL credit, so an unclamped warm-up converges a
 * limit created last week to ~1.0 while its own page reads under half that.
 * That is every limit habit's opening state, which makes it the reading a user
 * is most likely to meet first.
 *
 * Over the ordinary 30-day request rather than the short window above, and
 * deliberately: the disagreement is about days before the habit existed, so it
 * does not need a narrow window to show, and pinning it here says the DEFAULT
 * question this route is asked answers honestly for this shape.
 */

const avoidCategory = await (await postJson('/api/categories',
  { name: 'Compare Avoid', color: '#b45309' })).json();
const avoidHabit = await makeHabit({
  name: 'Compare Avoid habit', type: 'numerical', unit: 'cans',
  target_type: 'at_most', target_value: 0,
  at_most_unlogged: 'success', show_as: 'avoid',
  category_id: avoidCategory.id,
});
// One slip, ten days back — `target + 1`, which is what `valueForState` writes
// for a slip on an avoided habit. Every other day of its life is unlogged,
// which is the state the setting counts as kept.
await fetch(`${base}/api/habits/${avoidHabit.id}/entries/${addDays(STATS_END, -10)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 1 }),
});

const avoidOwnPage = await (await fetch(
  `${base}/api/habits/${avoidHabit.id}/stats?end=${STATS_END}`)).json();
const avoidOwnScore = avoidOwnPage.scores?.at(-1)?.score;

ck('sanity: this habit\'s unlogged days really do count as kept',
  avoidOwnPage.habit?.unlogged_is_success === true,
  JSON.stringify(avoidOwnPage.habit?.unlogged_is_success));
// The control that makes the assertion able to fail: a member already near 1.0
// on its own page would agree with a converged comparison by accident.
ck('sanity: and its own page has it well short of converged',
  typeof avoidOwnScore === 'number' && avoidOwnScore > 0.1 && avoidOwnScore < 0.75,
  JSON.stringify(avoidOwnScore));

const withAvoid = await categoryStats();
const avoidSection = withAvoid.categories.find((c) => c.id === avoidCategory.id);

ck('sanity: the avoid habit is the one member of its category',
  avoidSection?.members === 1 && avoidSection?.unloggedExcluded === 0,
  JSON.stringify({ members: avoidSection?.members,
                   unlogged: avoidSection?.unloggedExcluded }));
ck('THE assertion: a limit created inside the window reads the same here as on ' +
  'its own page — a warm-up not clamped to the member\'s first entry credits ' +
  '400 days before it existed as kept and converges it to ~1.0',
  avoidSection?.mean === avoidOwnScore && typeof avoidOwnScore === 'number',
  JSON.stringify({ mean: avoidSection?.mean, ownScore: avoidOwnScore }));
ck('...and the chart\'s last point is that same number here too',
  avoidSection?.series.at(-1)?.value === avoidSection?.mean,
  JSON.stringify({ last: avoidSection?.series.at(-1)?.value, mean: avoidSection?.mean }));

/* -- issue #223: the LIFETIME first ANSWER is a second thing only SQL can say --
 *
 * The block above pins that the comparison agrees with a habit's own page about
 * the WARM-UP. This pins the other date the route has to supply: the day silence
 * may start counting as success. `computeCategoryStats` derives it from the
 * `entries` it was handed when the key is absent — and this route hands it a
 * slice starting 400 days before the window, so a habit whose only stated answer
 * is OLDER than that slice would look, from inside the function, like a habit
 * that has never answered at all. It would then be credited from `end` alone: a
 * genuinely-converged limit habit reading ~0.05 on the comparison against ~1.0
 * on its own page, which is the same class of disagreement as the block above
 * with the sign reversed.
 *
 * So the fixture puts the stated answer OUTSIDE the fetched slice on purpose
 * (500 days back, against a slice opening at 429) and a skip inside it. Only a
 * route that asks the database for `MIN(date) ... WHERE status <> 'skip'` can
 * answer this; an entries-derived fallback cannot, whatever the shared function
 * does.
 */

const oldAnswerCategory = await (await postJson('/api/categories',
  { name: 'Compare Old Answer', color: '#0f766e' })).json();
const oldAnswerHabit = await makeHabit({
  name: 'Compare Old Answer habit', type: 'numerical', unit: 'cups',
  target_type: 'at_most', target_value: 2,
  at_most_unlogged: 'success', category_id: oldAnswerCategory.id,
});
// A stated answer 500 days back — outside the 429-day slice this route fetches
// — and a skip 400 days back, which is inside it. The skip is what the fallback
// would find, and it states nothing.
await fetch(`${base}/api/habits/${oldAnswerHabit.id}/entries/${addDays(STATS_END, -500)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 1 }),
});
await fetch(`${base}/api/habits/${oldAnswerHabit.id}/entries/${addDays(STATS_END, -400)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'skip' }),
});

const oldAnswerOwnPage = await (await fetch(
  `${base}/api/habits/${oldAnswerHabit.id}/stats?end=${STATS_END}`)).json();
const oldAnswerOwnScore = oldAnswerOwnPage.scores?.at(-1)?.score;
const withOldAnswer = await categoryStats();
const oldAnswerSection = withOldAnswer.categories.find((c) => c.id === oldAnswerCategory.id);

ck('sanity: a limit habit answered 500 days ago is converged on its own page',
  oldAnswerOwnScore === 1, JSON.stringify(oldAnswerOwnScore));
ck('THE assertion: the comparison credits it from that answer, which means the ' +
  'route asked SQL for the lifetime first ANSWER rather than letting the ' +
  'truncated slice decide there had never been one',
  oldAnswerSection?.mean === oldAnswerOwnScore,
  JSON.stringify({ mean: oldAnswerSection?.mean, ownScore: oldAnswerOwnScore }));
ck('...and the member still LANDS, the window not having moved',
  oldAnswerSection?.members === 1 && oldAnswerSection?.unloggedExcluded === 0,
  JSON.stringify({ members: oldAnswerSection?.members,
                   unlogged: oldAnswerSection?.unloggedExcluded }));

// The other half: a habit whose ONLY row is a skip has never answered, and both
// surfaces must say so. Without this the check above passes against a route that
// credits every member unconditionally — which is what it did before.
const skipOnlyHabit = await makeHabit({
  name: 'Compare Skip Only habit', type: 'numerical', unit: 'cups',
  target_type: 'at_most', target_value: 2,
  at_most_unlogged: 'success', category_id: oldAnswerCategory.id,
});
await fetch(`${base}/api/habits/${skipOnlyHabit.id}/entries/${addDays(STATS_END, -400)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'skip' }),
});

const skipOnlyOwn = await (await fetch(
  `${base}/api/habits/${skipOnlyHabit.id}/stats?end=${STATS_END}`)).json();
const skipOnlyOwnScore = skipOnlyOwn.scores?.at(-1)?.score;
const withSkipOnly = await categoryStats();
const twoMembers = withSkipOnly.categories.find((c) => c.id === oldAnswerCategory.id);

ck('sanity: a skip-only limit habit is NOT converged on its own page',
  typeof skipOnlyOwnScore === 'number' && skipOnlyOwnScore < 0.1,
  JSON.stringify(skipOnlyOwnScore));
ck('the comparison reads it as its own page does, so the two members are the ' +
  'mean of two different numbers rather than both flattered to 1.0',
  twoMembers?.members === 2
  && Math.abs(twoMembers.mean - (oldAnswerOwnScore + skipOnlyOwnScore) / 2) < 1e-12,
  JSON.stringify({ mean: twoMembers?.mean, own: oldAnswerOwnScore, skip: skipOnlyOwnScore }));
ck('...and the worst member named is the one with no evidence',
  twoMembers?.worst?.id === skipOnlyHabit.id, JSON.stringify(twoMembers?.worst));

/* -- the range bounds --
 *
 * The ceiling is this route's OWN, and it is 1830 days — five years — not the
 * 3660 of `/habits/:id/stats`. That route walks one habit; this one walks
 * every habit in the account, so `MAX_RANGE_DAYS` here buys a cost multiplied
 * by the habit count.
 *
 * 1830 and 1831 are written out rather than imported, on purpose. A test that
 * imports the constant it checks pins the NAME and nothing else and goes on
 * passing while the boundary moves underneath it — the exact way the `fresh`
 * window survived widening from 7 to 30.
 */

const tooWide = await fetch(statsUrl({
  start: addDays(STATS_END, -1831), end: STATS_END, granularity: 'month',
}));
ck('a window of 1831 days — one past this route\'s ceiling — gives 400',
  tooWide.status === 400, String(tooWide.status));

const atCeiling = await fetch(statsUrl({
  start: addDays(STATS_END, -1830), end: STATS_END, granularity: 'month',
}));
ck('...and exactly 1830 is still answered, so the bound is the documented one ' +
  'and not one day tighter',
  atCeiling.status === 200, String(atCeiling.status));

// The bound is this route's own and NOT the one /habits/:id/stats enforces:
// a span that route serves happily is refused here.
const atOtherCeiling = await fetch(statsUrl({
  start: addDays(STATS_END, -3660), end: STATS_END, granularity: 'month',
}));
ck('a 3660-day window — fine for one habit on /habits/:id/stats — is refused ' +
  'here, because this route walks every habit in the account',
  atOtherCeiling.status === 400, String(atOtherCeiling.status));

const backwards = await fetch(statsUrl({
  start: STATS_END, end: addDays(STATS_END, -1),
}));
ck('a start after end gives 400', backwards.status === 400, String(backwards.status));

const futureEnd = await categoryStats({ end: addDays(STATS_END, 10) });
ck("an end in the future is clamped to the caller's today",
  futureEnd.buckets.at(-1) === STATS_END,
  JSON.stringify({ last: futureEnd.buckets.at(-1), STATS_END }));

/* -- ...and a caller that names no start gets a YEAR, not the ceiling --
 *
 * The simplest request the route takes must not be the most expensive one it
 * can answer. At the ceiling this would be 1831 daily buckets PER CATEGORY for
 * asking the plainest possible question; a caller who wants five years says so.
 *
 * `COMPARE_WINDOW_DAYS` lives in `shared/src/stats.js` so the two editions
 * cannot answer a start-less URL with different bucket counts — and, like the
 * ceiling above, it is written out here rather than imported. Importing it
 * would pin the name and let the window move underneath this check; the 366 is
 * the inclusive day count `addDays(end, -365)` actually produces.
 */

const defaulted = await (await fetch(
  statsUrl({ end: STATS_END, granularity: 'day' })
)).json();
ck('an absent start opens the window a year before end, not at the ceiling',
  defaulted.buckets.length === 366 && defaulted.buckets[0] === addDays(STATS_END, -365),
  JSON.stringify({ buckets: defaulted.buckets.length, first: defaulted.buckets[0],
                   wanted: addDays(STATS_END, -365) }));

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

/* ---- issue #256 (round 2, FIX 3): the same collapse, under mode=replace ----
 *
 * Every block above is a MERGE. `mode=replace` wipes the account's
 * categories, habits and entries FIRST and only then re-applies the file's
 * own declared list, so there is no pre-existing row for a second declared
 * category to "attach to" the way a merge does — the account genuinely
 * loses a row a restore of the same file used to bring back, and before this
 * fix nothing said so.
 *
 * Run LAST, deliberately, and for the same reason as the LIMITS.categories
 * block just above it needs to be: this account is single-user, so there is
 * no second account to isolate a destructive `replace` against, and by this
 * point in the suite it is filled to LIMITS.categories with rows several
 * earlier blocks depend on staying put. Asserted against that pre-seeded
 * account rather than a fresh one — the category count is capped at
 * LIMITS.categories and there are many habits from every block above — or a
 * replace that quietly behaved like a merge (kept the seed, added the file's
 * rows beside it) would still pass every assertion below about the file's
 * own two categories.
 */
const seededCategoryCount = (await (await fetch(`${base}/api/categories`)).json()).length;
const seededHabitCount = (await (await fetch(`${base}/api/habits`)).json()).length;
ck('sanity: the account is seeded with more than the two rows this file ' +
  'declares, before the replace',
  seededCategoryCount > 2 && seededHabitCount > 2,
  JSON.stringify({ seededCategoryCount, seededHabitCount }));

const replaceBackup = Buffer.from(JSON.stringify({
  categories: [
    { name: 'Istanbul', color: '#101010' },
    { name: 'İstanbul', color: '#202020' },
  ],
  habits: [
    { name: 'issue-256 replace habit A', type: 'boolean', category: 'Istanbul', entries: [] },
    { name: 'issue-256 replace habit B', type: 'boolean', category: 'İstanbul', entries: [] },
  ],
}));
const replaceImportRes = await fetch(`${base}/api/import?mode=replace`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: replaceBackup,
});
ck('the replace-mode import itself succeeds',
  replaceImportRes.status === 200, String(replaceImportRes.status));
const replaceImportResult = await replaceImportRes.json();
ck(
  'THE assertion: the SECOND declared category (İstanbul) is reported in ' +
  'skipped under mode=replace too — the same collision-reporting rule the ' +
  'merge blocks above pin, now exercised on the path that wipes first',
  Array.isArray(replaceImportResult.skipped) &&
    replaceImportResult.skipped.some((s) => s.includes('İstanbul')),
  JSON.stringify(replaceImportResult.skipped));

const replaceCategories = await (await fetch(`${base}/api/categories`)).json();
ck('every pre-seeded category is GONE — proving this actually replaced ' +
  'rather than merged (a merge would have kept all ' +
  `${seededCategoryCount} of them beside the file's own)`,
  replaceCategories.length === 1, JSON.stringify(replaceCategories.map((c) => c.name)));
ck('THE assertion: exactly ONE category named either spelling survives the ' +
  'replace, carrying both habits',
  replaceCategories.length === 1 &&
    (replaceCategories[0].name === 'Istanbul' || replaceCategories[0].name === 'İstanbul'),
  JSON.stringify(replaceCategories));

const replaceHabits = await (await fetch(`${base}/api/habits`)).json();
ck('every pre-seeded habit is GONE too',
  replaceHabits.length === 2, JSON.stringify(replaceHabits.map((h) => h.name)));
const replaceHabitA = replaceHabits.find((h) => h.name === 'issue-256 replace habit A');
const replaceHabitB = replaceHabits.find((h) => h.name === 'issue-256 replace habit B');
ck(
  "THE assertion: both habits' category_id is the SAME id — the surviving " +
  'category, never a second row that was silently dropped',
  replaceHabitA?.category_id != null &&
    replaceHabitA.category_id === replaceHabitB?.category_id &&
    replaceHabitA.category_id === replaceCategories[0]?.id,
  `A=${replaceHabitA?.category_id} B=${replaceHabitB?.category_id} ` +
    `kept=${JSON.stringify(replaceCategories)}`);

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'all API shape checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
