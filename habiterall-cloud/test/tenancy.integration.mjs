/**
 * Adversarial tenancy tests against a real Postgres.
 *
 * These try to BREAK isolation, not confirm it: forged ids, missing WHERE
 * clauses, cross-user imports, and a direct attempt to bypass RLS.
 */
// Connection strings come from the environment so the same script serves CI
// (Postgres on 5432) and a local run against the compose stack (via a proxy
// on 55432). See test/README.md.
process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:55432/habiterall';
const ADMIN_URL = process.env.ADMIN_URL ??
  'postgres://owner:testpw@localhost:55432/habiterall';

const { withUser, withoutUser, pool } = await import('../src/db/pool.js');
const { applyImport } = await import('../src/apply-import.js');

let fails = 0;
const check = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};

// --- seed two users via the admin connection ---
const pg = (await import('pg')).default;
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query('DELETE FROM entries');
await admin.query('DELETE FROM habits');
await admin.query('DELETE FROM users');
const { rows: [alice] } = await admin.query(
  `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
   VALUES ('sub-alice','https://idp','alice@example.com','Alice') RETURNING id`);
const { rows: [bob] } = await admin.query(
  `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
   VALUES ('sub-bob','https://idp','bob@example.com','Bob') RETURNING id`);
console.log(`  alice=${alice.id}  bob=${bob.id}\n`);

// --- each user creates a habit with entries ---
const mk = async (userId, name) => withUser(userId, async (db) => {
  const { rows } = await db.query(
    `INSERT INTO habits (user_id, name, type) VALUES ($1,$2,'boolean') RETURNING id`,
    [userId, name]);
  const hid = rows[0].id;
  await db.query(
    `INSERT INTO entries (habit_id, user_id, date, value) VALUES ($1,$2,'2026-01-01',2)`,
    [hid, userId]);
  return hid;
});
const aliceHabit = await mk(alice.id, 'Alice Secret Habit');
const bobHabit = await mk(bob.id, 'Bob Secret Habit');

console.log('--- baseline ---');
const aliceSees = await withUser(alice.id, (db) =>
  db.query('SELECT name FROM habits').then(r => r.rows.map(x => x.name)));
check('alice sees only her own habit',
  aliceSees.length === 1 && aliceSees[0] === 'Alice Secret Habit', JSON.stringify(aliceSees));

console.log('--- attack: unqualified SELECT (a forgotten WHERE clause) ---');
const all = await withUser(alice.id, (db) =>
  db.query('SELECT * FROM habits').then(r => r.rows.length));
check('SELECT with no WHERE returns only alice rows', all === 1, `rows=${all}`);
const allEntries = await withUser(alice.id, (db) =>
  db.query('SELECT * FROM entries').then(r => r.rows.length));
check('entries with no WHERE returns only alice rows', allEntries === 1, `rows=${allEntries}`);

console.log('--- attack: address another user by id directly ---');
const stolen = await withUser(alice.id, (db) =>
  db.query('SELECT * FROM habits WHERE id = $1', [bobHabit]).then(r => r.rows.length));
check("alice cannot SELECT bob's habit by id", stolen === 0, `rows=${stolen}`);

const updated = await withUser(alice.id, (db) =>
  db.query(`UPDATE habits SET name='pwned' WHERE id=$1`, [bobHabit]).then(r => r.rowCount));
check("alice cannot UPDATE bob's habit", updated === 0, `rowCount=${updated}`);

const deleted = await withUser(alice.id, (db) =>
  db.query('DELETE FROM habits WHERE id=$1', [bobHabit]).then(r => r.rowCount));
check("alice cannot DELETE bob's habit", deleted === 0, `rowCount=${deleted}`);

const stolenEntries = await withUser(alice.id, (db) =>
  db.query('SELECT * FROM entries WHERE habit_id=$1', [bobHabit]).then(r => r.rows.length));
check("alice cannot read bob's entries", stolenEntries === 0, `rows=${stolenEntries}`);

console.log('--- attack: INSERT a row owned by someone else ---');
let insertBlocked = false;
try {
  await withUser(alice.id, (db) =>
    db.query(`INSERT INTO habits (user_id, name, type) VALUES ($1,'forged','boolean')`, [bob.id]));
} catch (e) { insertBlocked = /row-level security|violates/i.test(e.message); }
check('alice cannot INSERT a habit owned by bob (WITH CHECK)', insertBlocked);

let entryBlocked = false;
try {
  await withUser(alice.id, (db) =>
    db.query(`INSERT INTO entries (habit_id,user_id,date,value) VALUES ($1,$2,'2026-02-02',2)`,
      [bobHabit, bob.id]));
} catch (e) { entryBlocked = /row-level security|violates/i.test(e.message); }
check('alice cannot INSERT an entry into bob\'s habit', entryBlocked);

console.log('--- attack: cross-user import (ids inside the file) ---');
// A backup that claims bob's habit id and user id.
const malicious = [{
  id: bobHabit, user_id: bob.id, name: 'Bob Secret Habit', type: 'boolean',
  entries: [{ date: '2026-03-03', value: 2, notes: 'injected' }],
}];
const res = await applyImport(alice.id, malicious, 'merge');
check('import completes without error', res.habitsCreated + res.habitsMerged === 1,
  JSON.stringify(res));

const bobUntouched = await withUser(bob.id, (db) =>
  db.query(`SELECT COUNT(*)::int c FROM entries WHERE habit_id=$1`, [bobHabit])
    .then(r => r.rows[0].c));
check("bob's habit is untouched by alice's import", bobUntouched === 1, `entries=${bobUntouched}`);

const aliceNow = await withUser(alice.id, (db) =>
  db.query(`SELECT h.name, COUNT(e.*)::int AS n FROM habits h
            LEFT JOIN entries e ON e.habit_id=h.id GROUP BY h.name ORDER BY h.name`)
    .then(r => r.rows));
check('the imported habit landed in alice\'s own account',
  aliceNow.some(r => r.name === 'Bob Secret Habit'), JSON.stringify(aliceNow));

const bobStillOwns = await withUser(bob.id, (db) =>
  db.query(`SELECT name FROM habits`).then(r => r.rows.map(x => x.name)));
check('bob still sees exactly one habit', bobStillOwns.length === 1, JSON.stringify(bobStillOwns));

console.log('--- attack: replace-mode import cannot wipe another user ---');
await applyImport(alice.id, [{ name: 'Fresh', type: 'boolean', entries: [] }], 'replace');
const bobAfterReplace = await withUser(bob.id, (db) =>
  db.query('SELECT COUNT(*)::int c FROM habits').then(r => r.rows[0].c));
check("alice's 'replace' did not delete bob's habits", bobAfterReplace === 1, `bob habits=${bobAfterReplace}`);

console.log('--- attack: no user context set at all ---');
let noCtx = 0;
try {
  noCtx = await withoutUser((db) =>
    db.query('SELECT COUNT(*)::int c FROM habits').then(r => r.rows[0].c));
} catch { noCtx = -1; }
check('with no app.user_id the app role sees zero rows', noCtx === 0, `rows=${noCtx}`);

console.log('--- app role privileges ---');
const roleInfo = await withoutUser((db) =>
  db.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname=current_user`)
    .then(r => r.rows[0]));
check('app role cannot bypass RLS', roleInfo.rolbypassrls === false, JSON.stringify(roleInfo));
check('app role is not superuser', roleInfo.rolsuper === false, JSON.stringify(roleInfo));

let ddlBlocked = false;
try { await withoutUser((db) => db.query('DROP TABLE entries')); }
catch (e) { ddlBlocked = true; }
check('app role cannot DROP tables', ddlBlocked);

let policyBlocked = false;
try { await withoutUser((db) => db.query('ALTER TABLE habits DISABLE ROW LEVEL SECURITY')); }
catch (e) { policyBlocked = true; }
check('app role cannot disable RLS', policyBlocked);

/* ---------- attack: squat on another user's habit/date slot ---------- */

console.log("--- attack: plant a row on someone else's habit id ---");

// The blind spot this suite had. The forged INSERT earlier uses the VICTIM's
// user_id, which RLS has always rejected. The dangerous variant uses the
// ATTACKER's own user_id with the victim's habit_id — every predicate on
// `user_id` is then satisfied, and nothing tied habit_id to the same owner.
//
// It is a denial of service rather than a leak: `entries` is keyed on
// (habit_id, date), so the planted row occupies that slot permanently. The
// victim's upsert hits ON CONFLICT against a row they cannot see and errors,
// and their DELETE matches nothing — with no way to self-remedy.
// bobHabit already exists above; reuse it rather than creating another.
const victimHabit = bobHabit;

let squatBlocked = false;
try {
  await withUser(alice.id, (db) => db.query(
    `INSERT INTO entries (user_id, habit_id, date, value, status)
     VALUES ($1, $2, '2026-05-01', 2, '')`,
    [alice.id, victimHabit]
  ));
} catch (e) { squatBlocked = true; }
check("alice cannot attach an entry to bob's habit", squatBlocked);

// And the victim must still be able to use that slot afterwards.
let victimOk = false;
try {
  await withUser(bob.id, (db) => db.query(
    `INSERT INTO entries (user_id, habit_id, date, value, status)
     VALUES ($1, $2, '2026-05-01', 2, '')`,
    [bob.id, victimHabit]
  ));
  const cleared = await withUser(bob.id, async (db) => (await db.query(
    `DELETE FROM entries WHERE habit_id = $1 AND date = '2026-05-01'`,
    [victimHabit]
  )).rowCount);
  victimOk = cleared === 1;
} catch { victimOk = false; }
check('bob can still write and clear that day', victimOk);

/* ---------- the reminder scheduler's scope ---------- */
//
// Migration 008 adds the only policy in the schema that lets a query see more
// than one user's rows. It is gated on a transaction-local `app.scope` flag
// that the request path never sets, and it is FOR SELECT on `users` alone —
// these checks are what says so.

console.log('--- notify_log is isolated like everything else ---');
// Fresh habits: the replace-mode import attack above deleted alice's original.
const aliceReminder = await mk(alice.id, 'Alice Reminder Habit');

await withUser(alice.id, (db) => db.query(
  `INSERT INTO notify_log (user_id, habit_id, channel, date)
   VALUES ($1, $2, 'discord', '2026-01-01')`, [alice.id, aliceReminder]));

const bobSeesLog = await withUser(bob.id, (db) =>
  db.query('SELECT * FROM notify_log').then(r => r.rows.length));
check('bob cannot read alice\'s send history', bobSeesLog === 0, `rows=${bobSeesLog}`);

// The same attack as migration 007's, on the new table: the primary key is
// (habit_id, channel, date) with no user_id, so a row carrying the attacker's
// user_id and the victim's habit_id would occupy a slot the victim cannot see
// — and the victim's own INSERT would then fail on a conflict with an
// invisible row, costing them that reminder permanently.
let logSquatBlocked = false;
try {
  await withUser(bob.id, (db) => db.query(
    `INSERT INTO notify_log (user_id, habit_id, channel, date)
     VALUES ($1, $2, 'discord', '2026-02-02')`, [bob.id, aliceReminder]));
} catch { logSquatBlocked = true; }
check("bob cannot log a send against alice's habit", logSquatBlocked);

let aliceCanStillLog = false;
try {
  await withUser(alice.id, (db) => db.query(
    `INSERT INTO notify_log (user_id, habit_id, channel, date)
     VALUES ($1, $2, 'discord', '2026-02-02')`, [alice.id, aliceReminder]));
  aliceCanStillLog = true;
} catch { aliceCanStillLog = false; }
check('and alice can still use that slot herself', aliceCanStillLog);

console.log('--- notify_status is isolated too ---');
// The table that tells a user their reminders stopped arriving. It carries an
// error string straight from Discord, so a leak here would hand one account a
// running commentary on another's destinations.
await withUser(alice.id, (db) => db.query(
  `INSERT INTO notify_status (user_id, channel, ok, status, error)
   VALUES ($1, 'discord', false, 404, 'alice private failure')`, [alice.id]));

const bobSeesStatus = await withUser(bob.id, (db) =>
  db.query('SELECT * FROM notify_status').then((r) => r.rows.length));
check("bob cannot read alice's delivery failures", bobSeesStatus === 0,
  `rows=${bobSeesStatus}`);

// The key leads with user_id, so the squat that migration 007/008 guards
// against cannot arise here — but a forged user_id on an INSERT must still be
// refused by WITH CHECK, exactly as everywhere else.
let statusForgeBlocked = false;
try {
  await withUser(bob.id, (db) => db.query(
    `INSERT INTO notify_status (user_id, channel, ok) VALUES ($1, 'discord', true)`,
    [alice.id]));
} catch { statusForgeBlocked = true; }
check("bob cannot write a delivery outcome into alice's account", statusForgeBlocked);

// And bob keeps his own row, on the same channel, unaffected by alice's.
let bobHasHisOwn = false;
try {
  await withUser(bob.id, (db) => db.query(
    `INSERT INTO notify_status (user_id, channel, ok) VALUES ($1, 'discord', true)`,
    [bob.id]));
  bobHasHisOwn = true;
} catch { bobHasHisOwn = false; }
check('and bob has his own row for the same channel', bobHasHisOwn);

// Nothing deletes one; the app role should not be able to either.
let statusDeleteBlocked = false;
try {
  await withUser(alice.id, (db) => db.query(`DELETE FROM notify_status`));
} catch { statusDeleteBlocked = true; }
check('the app role cannot DELETE from notify_status', statusDeleteBlocked);

console.log('--- attack: claim the notifier scope from a user session ---');
const scoped = async (claimScope) => withUser(alice.id, async (db) => {
  if (claimScope) await db.query(`SELECT set_config('app.scope', 'notifier', true)`);
  return {
    users: (await db.query('SELECT COUNT(*)::int c FROM users')).rows[0].c,
    habits: (await db.query('SELECT COUNT(*)::int c FROM habits')).rows[0].c,
  };
});
// Compared against the same request without the flag, rather than against a
// hardcoded count: what matters is that claiming the scope changes nothing.
const honest = await scoped(false);
const forged = await scoped(true);
check('the scope flag cannot widen a request that has a user',
  forged.users === 1 && JSON.stringify(forged) === JSON.stringify(honest),
  `${JSON.stringify(honest)} -> ${JSON.stringify(forged)}`);

console.log('--- the scan itself sees users, and nothing else ---');
const { withNotifierScope } = await import('../src/db/pool.js');
const scan = await withNotifierScope(async (db) => ({
  users: (await db.query('SELECT COUNT(*)::int c FROM users')).rows[0].c,
  habits: (await db.query('SELECT COUNT(*)::int c FROM habits')).rows[0].c,
  entries: (await db.query('SELECT COUNT(*)::int c FROM entries')).rows[0].c,
  log: (await db.query('SELECT COUNT(*)::int c FROM notify_log')).rows[0].c,
  // `users_notifier_scan` is FOR SELECT on `users` alone, so this must be 0 —
  // and it is worth asking, because notify_status is the newest table the
  // notifier writes and it carries an error string straight from Discord.
  status: (await db.query('SELECT COUNT(*)::int c FROM notify_status')).rows[0].c,
}));
check('the scan can enumerate accounts (it has to)', scan.users === 2, JSON.stringify(scan));
check('but reaches no habit, entry, send history or delivery report',
  scan.habits === 0 && scan.entries === 0 && scan.log === 0 && scan.status === 0,
  JSON.stringify(scan));

let scanWriteBlocked = false;
try {
  await withNotifierScope((db) =>
    db.query(`UPDATE users SET display_name = 'pwned' WHERE id = $1`, [alice.id]));
} catch { scanWriteBlocked = true; }
check('the scan cannot write anything', scanWriteBlocked);

console.log('--- and the flag does nothing without the scope helper ---');
let plainNoCtx = 0;
try {
  plainNoCtx = await withoutUser((db) =>
    db.query('SELECT COUNT(*)::int c FROM users').then(r => r.rows[0].c));
} catch { plainNoCtx = -1; }
check('no user and no scope still sees zero users', plainNoCtx === 0, `rows=${plainNoCtx}`);

await admin.end();
await pool.end();
console.log(fails === 0 ? '\nALL TENANCY CHECKS PASSED' : `\n${fails} TENANCY CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
