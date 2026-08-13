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

const overview = await (await fetch(`${base}/api/overview?days=7&archived=true`)).json();
if (overview.habits.length) checkShape('GET /overview', overview.habits[0]);

const exported = await (await fetch(`${base}/api/export`)).json();
if (exported.habits.length) checkShape('GET /export', exported.habits[0]);

server.close();
try { (await import('../src/db.js')).db.close(); } catch { /* already closed */ }
try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${fails === 0 ? 'all API shape checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
