/**
 * Backup round-trip fidelity, cloud edition.
 *
 * The same fixture and the same comparison rules as the personal edition's
 * suite, so the two cannot drift on what a faithful restore means. Runs
 * against the data layer rather than over HTTP, for the same reason
 * api.integration.mjs does: no browser and no identity provider, so it can
 * run on every pull request.
 *
 * Adds the check the personal edition has no equivalent of: a restore must
 * land entirely inside the importing account.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/roundtrip.integration.mjs
 */

process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';
const ADMIN_URL = process.env.ADMIN_URL ??
  'postgres://owner:testpw@localhost:5432/habiterall';

const { withUser, pool } = await import('../src/db/pool.js');
const { applyImport } = await import('../src/apply-import.js');
const { writeLoopDatabase } = await import('@habiterall/shared/export-loop.js');
const { buildCsvArchive } = await import('@habiterall/shared/export-csv.js');
const {
  parseLoopDatabase, parseHabiterallJSON,
  parseLoopCheckmarksCSV, parseLoopHabitsCSV, backupCategories,
} = await import('@habiterall/shared/import.js');
const { unzip } = await import('@habiterall/shared/unzip.js');
// LIMITS because the clamp import must honour is the one the API enforces, so
// the test asks the same table rather than restating a number.
const { parseSettings, portableSettings, LIMITS } =
  await import('@habiterall/shared/validate.js');
const {
  FIXTURE, FIXTURE_CATEGORIES, snapshot, diff, checkAgainstFixture,
  LOOP_HABIT_FIELDS, LOOP_DB_HABIT_FIELDS, CSV_HABIT_FIELDS, JSON_HABIT_FIELDS,
} = await import('@habiterall/shared/test/roundtrip-fixture.mjs');

const pg = (await import('pg')).default;
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { readFileSync, unlinkSync } = await import('node:fs');

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();

await admin.query('DELETE FROM entries');
await admin.query('DELETE FROM habits');
await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'rt-%'`);

const mkUser = async (sub) => {
  const { rows } = await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
     VALUES ($1, 'https://ci.example', $2, $3) RETURNING id`,
    [sub, `${sub}@example.com`, sub]
  );
  return rows[0].id;
};

const alice = await mkUser('rt-alice');
const bob = await mkUser('rt-bob');
console.log(`  alice=${alice}  bob=${bob}\n`);

/* ---------- helpers ---------- */

/** Seed the fixture into a user's account, directly. */
async function seed(userId) {
  await withUser(userId, async (db) => {
    // The fixture names a category by NAME (see roundtrip-fixture.mjs), and
    // the column is `category_id` — the same shape `applyImport` resolves a
    // backup's `category` against. Created here, once per distinct name,
    // before any habit so the INSERT below has an id to write. Writing the
    // columns by hand is the cost of not going through a route, same as
    // every other field in this function's own header comment.
    //
    // `FIXTURE_CATEGORIES` carries each one's own colour and declared
    // position now — see its own comment for why neither is a value a naive
    // re-creation would produce, which is what made this section's earlier
    // `'#3b82f6'` plus an auto-incrementing position unable to catch the CSV
    // archive losing either on the way through Categories.csv.
    const categoryIds = new Map();
    for (const cat of FIXTURE_CATEGORIES) {
      const { rows } = await db.query(
        `INSERT INTO categories (user_id, name, color, position)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, cat.name, cat.color, cat.position]
      );
      categoryIds.set(cat.name, rows[0].id);
    }

    for (const [i, h] of FIXTURE.entries()) {
      const { rows } = await db.query(
        // reminder_message was absent here while the fixture carried one, so
        // every comparison of it held '' against '' and passed. The personal
        // suite seeds through the API and never had the gap; this one writes
        // the columns by hand, which is the cost of not going through a route.
        //
        // `at_most_unlogged` walked into the same hole one field later, which
        // is why this list is worth re-reading rather than appended to: the
        // fixture sets it to 'success' precisely so a comparison is not two
        // defaults agreeing, and a seed that omits it puts the default back and
        // makes the assertion vacuous again. Every field the fixture carries
        // has to be written HERE, or this suite watches it in name only.
        // `icon` is the same trap one field later still: seeded as `h.icon ?? ''`
        // beside `show_as`, or every habit's icon compares '' against '' and the
        // fidelity list watches nothing. `category_id` is the same trap again,
        // resolved against `categoryIds` above rather than left null, or every
        // habit's category compares '' against '' and this suite watches
        // nothing either.
        `INSERT INTO habits (user_id, name, description, type, unit, target_value,
                             target_type, freq_numerator, freq_denominator, color,
                             reminder_time, reminder_message, at_most_unlogged,
                             show_as, icon, position, archived, category_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [userId, h.name, h.description, h.type, h.unit, h.target_value,
          h.target_type, h.freq_numerator, h.freq_denominator, h.color,
          h.reminder_time ?? '', h.reminder_message ?? '',
          h.at_most_unlogged ?? 'default', h.show_as ?? 'amount', h.icon ?? '', i, h.archived,
          categoryIds.get(h.category) ?? null]
      );
      const habitId = rows[0].id;

      for (const e of h.entries) {
        await db.query(
          `INSERT INTO entries (user_id, habit_id, date, value, status, notes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [userId, habitId, e.date, e.value, e.status ?? '', e.notes]
        );
      }
    }
  });
}

/** Read a user's whole dataset in the shared export shape. */
async function read(userId) {
  return withUser(userId, async (db) => {
    const { rows: habits } = await db.query(
      `SELECT * FROM habits ORDER BY archived, position, id`);
    const { rows: entries } = await db.query(
      `SELECT habit_id, to_char(date, 'YYYY-MM-DD') AS date, value, status, notes
       FROM entries ORDER BY date`);
    // The backup carries a category by NAME, not by id — see the /export
    // route's own comment. `checkAgainstFixture` and `snapshot` both compare
    // `category` as a name, so this reader has to produce the same field the
    // real route does or every comparison would be against `undefined`.
    const { rows: categoryRows } = await db.query(`SELECT id, name FROM categories`);
    const categoryNames = new Map(categoryRows.map((c) => [c.id, c.name]));

    const byHabit = new Map(habits.map((h) => [h.id, []]));
    for (const e of entries) {
      byHabit.get(e.habit_id)?.push({
        date: e.date,
        value: Number(e.value),
        status: e.status ?? '',
        notes: e.notes ?? '',
      });
    }
    return habits.map((h) => ({
      ...h,
      reminder_time: h.reminder_time ?? '',
      reminder_message: h.reminder_message ?? '',
      category: categoryNames.get(h.category_id) ?? '',
      entries: byHabit.get(h.id) ?? [],
    }));
  });
}

async function wipe(userId) {
  await withUser(userId, async (db) => {
    await db.query('DELETE FROM entries');
    await db.query('DELETE FROM habits');
  });
}

// Hoisted so both the CSV section and the category-resolution section below
// can use one definition.
const categoriesOf = async (u) => withUser(u, (db) =>
  db.query(`SELECT id, name, color, position FROM categories ORDER BY position, id`)
    .then((r) => r.rows));

/** The JSON backup payload the /export route builds. */
const toJsonBackup = (habits) => ({
  version: 1, app: 'habiterall', habits,
});

/** Same stated-lapse rule as the personal suite. */
function statedLapses() {
  return FIXTURE
    .filter((h) => h.type === 'boolean')
    .flatMap((h) => h.entries.filter((e) => e.status !== 'skip' && e.value === 0));
}

/**
 * FIXTURE habits that declare an icon at all. The same guard `statedLapses()`
 * is for: without it, "every restored habit has icon === ''" would pass
 * whether or not the format actually dropped anything, because a fixture with
 * nothing to lose satisfies it either way.
 */
function habitsWithIcon() {
  return FIXTURE.filter((h) => (h.icon ?? '') !== '');
}

/* ---------- baseline ---------- */

console.log('--- baseline ---');

await seed(alice);
const seeded = await read(alice);
const baselineFull = snapshot(seeded, { fields: JSON_HABIT_FIELDS });
const baselineLoop = snapshot(seeded, { fields: LOOP_HABIT_FIELDS, notes: false });
// The CSV keeps the colour exactly, where the .db snaps it to a palette index.
const baselineCsv = snapshot(seeded, { fields: CSV_HABIT_FIELDS, notes: false });
// The .db carries a reminder time as well, and per-day notes, which is why this
// one is not `notes: false`. Habits.csv has no column for either.
const baselineLoopDb = snapshot(seeded, { fields: LOOP_DB_HABIT_FIELDS });

ck('fixture seeded', baselineFull.length === FIXTURE.length,
  `${baselineFull.length} habits`);

// Against the fixture rather than against the seed. This suite writes its
// columns by hand, which is how `reminder_message` sat comparing '' with ''
// for as long as it did; the fixture is the only description of the data that
// does not come out of the code under test.
checkAgainstFixture(baselineFull, ck);

const water = baselineFull.find((h) => h.name === 'Water');
ck('a literal 3 on a numerical habit is not a skip',
  water.entries.some((e) => e.startsWith('2026-01-06|3|') && !e.includes('|skip')),
  water.entries.find((e) => e.startsWith('2026-01-06')));

/* ---------- JSON: lossless ---------- */

console.log('\n--- JSON backup (lossless) ---');

const jsonBackup = toJsonBackup(seeded);
await wipe(alice);
const jsonResult = await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');
const afterJson = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });

ck('JSON round-trip preserves everything',
  diff(baselineFull, afterJson) === null,
  diff(baselineFull, afterJson) ?? '');
ck('JSON restore skipped nothing',
  jsonResult.skipped.length === 0, jsonResult.skipped.join('; '));

// Idempotence: restoring the same backup again must not change or duplicate.
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');
const afterTwice = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });
ck('a second JSON restore is idempotent',
  diff(baselineFull, afterTwice) === null,
  diff(baselineFull, afterTwice) ?? '');

/* ---------- what a merge must not do, and what a backup may carry ---------- */

console.log('\n--- merge, and the settings a file may set ---');

// A row is an answer now, so a file's bare "not done" reaches the writer where it
// used to be dropped. In merge mode it must yield to an answer the account
// already has: a Loop backup is full of explicit NO rows, and merging one taken
// before the web history would otherwise wipe every completion they disagree on.
await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');
const lapseFile = parseHabiterallJSON({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Meditate', type: 'boolean',
    entries: [
      { date: '2026-01-05', value: 0, status: '', notes: '' },   // a completion
      { date: '2026-01-11', value: 0, status: '', notes: '' },   // no row at all
    ],
  }],
});
const mergedLapses = await applyImport(alice, lapseFile, 'merge');
const meditate = (await read(alice)).find((h) => h.name === 'Meditate');
const on = (date) => meditate.entries.find((e) => e.date === date);

ck('a merge leaves a completion it disagrees with alone',
  Number(on('2026-01-05')?.value) === 2, JSON.stringify(on('2026-01-05')));
ck('and reports the day it kept', mergedLapses.entriesKept === 1,
  JSON.stringify(mergedLapses));
ck('while a lapse on an unanswered day still lands',
  Number(on('2026-01-11')?.value) === 0 && on('2026-01-11')?.status === '',
  JSON.stringify(on('2026-01-11')));

/* ---------- ...and the same promise on a MEASURABLE habit ---------- */

console.log('\n--- merge does not overwrite an amount either ---');

// Everything above this line is about Meditate, which is boolean — and the yield
// was gated on `type === 'boolean'`, so both suites watched the protection work
// right beside the hole. A numerical habit's lapse is a row holding 0 too.
const habitNamed = async (name) => (await read(alice)).find((h) => h.name === name);
const dayOf = async (name, date) =>
  (await habitNamed(name)).entries.find((e) => e.date === date);

await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');

const mergedZeros = await applyImport(alice, parseHabiterallJSON({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Water', type: 'numerical',
    // 01-05 holds 8 glasses in the fixture; 01-11 has no row at all.
    entries: [
      { date: '2026-01-05', value: 0, status: '', notes: '' },
      { date: '2026-01-11', value: 0, status: '', notes: '' },
    ],
  }],
}), 'merge');

ck('a bare 0 does not overwrite a recorded amount',
  Number((await dayOf('Water', '2026-01-05'))?.value) === 8,
  JSON.stringify(await dayOf('Water', '2026-01-05')));
ck('and the day it kept is counted as kept',
  mergedZeros.entriesKept === 1 && mergedZeros.entriesImported === 1,
  JSON.stringify(mergedZeros));
ck('while a 0 on a day the habit has no answer for still lands',
  Number((await dayOf('Water', '2026-01-11'))?.value) === 0,
  JSON.stringify(await dayOf('Water', '2026-01-11')));

/* ---------- a merge types entries by the habit, not by the file ---------- */

console.log('\n--- the account\'s own type decides what a value means ---');

await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');

// The most ordinary file there is: a bare Checkmarks.csv, with no Habits.csv
// beside it to say what a habit is, so every column parses as boolean. Merged
// into this account it rewrote 8 and 10 glasses to the YES sentinel — 2, against
// a target of 8 — and reported two imported entries and no error at all.
const mergedCsvTypes = await applyImport(alice, parseLoopCheckmarksCSV([
  'Date,Water',
  '2026-01-05,YES_MANUAL',
  '2026-01-07,YES_MANUAL',
  '2026-01-12,NO',
].join('\n') + '\n'), 'merge');

ck('a yes/no file does not restate an amount',
  Number((await dayOf('Water', '2026-01-05'))?.value) === 8 &&
  Number((await dayOf('Water', '2026-01-07'))?.value) === 10,
  JSON.stringify((await habitNamed('Water')).entries));
ck('and the days it could not translate are reported',
  mergedCsvTypes.skipped.length === 1 && mergedCsvTypes.skipped[0].includes('Water'),
  JSON.stringify(mergedCsvTypes.skipped));
ck('but a NO still crosses, since a lapse means the same on both sides',
  Number((await dayOf('Water', '2026-01-12'))?.value) === 0,
  JSON.stringify(await dayOf('Water', '2026-01-12')));

// And the other direction, which `PUT /entries/:date` answers 400 to: an 8 on a
// boolean habit is a day `isCompleted` reads as not done forever, and the tap
// cycle has no state for it.
const mergedClaim = await applyImport(alice, parseHabiterallJSON({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Meditate', type: 'numerical',
    entries: [{ date: '2026-01-12', value: 8, status: '', notes: '' }],
  }],
}), 'merge');

ck('an import claiming a yes/no habit is measurable writes no amount',
  (await dayOf('Meditate', '2026-01-12')) === undefined &&
  mergedClaim.skipped.length === 1,
  JSON.stringify([await dayOf('Meditate', '2026-01-12'), mergedClaim.skipped]));

/* ---------- an import obeys the rules the API obeys ---------- */

console.log('\n--- impossible dates, and over-long notes ---');

await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');

// `2026-02-30` matches YYYY-MM-DD and is not a day. Here it reached Postgres,
// where the column is a real DATE: a 22008 that surfaced as an unhandled 500 and
// rolled back the entire upload — the personal edition stored the string instead.
// One check in the same place ends both.
const badDates = await applyImport(alice, parseHabiterallJSON({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Meditate', type: 'boolean',
    entries: [
      { date: '2026-02-30', value: 2, status: '', notes: '' },
      { date: '2026-13-45', value: 2, status: '', notes: '' },
      { date: '2026-01-12', value: 2, status: '', notes: '' },
    ],
  }],
}), 'merge');
const meditateDates = (await habitNamed('Meditate')).entries.map((e) => e.date);

ck('a date that is not a day is reported rather than thrown',
  badDates.skipped.length === 2 &&
  !meditateDates.some((d) => d === '2026-02-30' || d === '2026-13-45'),
  JSON.stringify([badDates.skipped, meditateDates]));
ck('and the rest of the file still lands',
  badDates.entriesImported === 1 && meditateDates.includes('2026-01-12'),
  JSON.stringify(badDates));

// Cloud has always clamped these and personal had no clamp at all, so the two
// disagreed about what an import may store — and the number was written out here
// rather than derived, which is how it drifted from the API's in the first place.
const longNote = 'x'.repeat(LIMITS.notes + 400);
await applyImport(alice, parseHabiterallJSON({
  version: 1, app: 'habiterall',
  habits: [{
    name: 'Meditate', type: 'boolean',
    entries: [
      { date: '2026-01-13', value: 2, status: '', notes: longNote },
      { date: '2026-01-14', value: 0, status: 'skip', notes: longNote },
    ],
  }],
}), 'merge');

ck('an imported note is clamped to what the API stores',
  (await dayOf('Meditate', '2026-01-13'))?.notes.length === LIMITS.notes,
  String((await dayOf('Meditate', '2026-01-13'))?.notes.length));
ck('a skip\'s note too, which took the other path out',
  (await dayOf('Meditate', '2026-01-14'))?.notes.length === LIMITS.notes,
  String((await dayOf('Meditate', '2026-01-14'))?.notes.length));

/* ---------- "the file said nothing" has more than one spelling ---------- */

console.log('\n--- an entry with no value is not a lapse ---');

await wipe(alice);

// `Number(null)` and `Number('')` are both 0, and 0 is a real answer here: a row
// holding zero is a STATED lapse, one of the four day-states. So `{date, value:
// null}` was written as a day the user said they had missed, while `{date}` with
// no value key at all was correctly refused — two spellings of the same silence
// behaving differently. REPLACE mode is where it costs something: a merge yields
// a bare lapse to whatever the account holds, but a replace has nothing to yield
// to, and an invented lapse extends the habit's history window back to its own
// date and turns `recovery.rate === null` into a real lapse.
//
// The personal edition asserts the same file, day for day. Two writers that
// disagree about what an absent value means is the drift the root CLAUDE.md
// calls the worst kind of bug here.
const nothings = await applyImport(alice, parseHabiterallJSON({
  version: 1, app: 'habiterall',
  habits: [
    {
      name: 'Meditate', type: 'boolean',
      entries: [
        { date: '2026-02-01', value: null },
        { date: '2026-02-02' },
        { date: '2026-02-03', value: '' },
        { date: '2026-02-04', value: false },
        { date: '2026-02-05', value: 0 },      // this one IS a stated lapse
        { date: '2026-02-06', value: 2 },
      ],
    },
    // The guard is about the type of "nothing", not about tightening what counts
    // as a number: a quoted amount is an amount the file stated, and still lands.
    {
      name: 'Water', type: 'numerical',
      entries: [{ date: '2026-02-07', value: '8' }],
    },
  ],
}), 'replace');
const answered = (await habitNamed('Meditate')).entries.map((e) => e.date);

ck('null, absent, empty and false are all "the file said nothing"',
  !answered.some((d) =>
    ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04'].includes(d)),
  JSON.stringify(answered));
ck('and each is reported rather than silently dropped',
  nothings.skipped.filter((s) => s.startsWith('bad value')).length === 4,
  JSON.stringify(nothings.skipped));
ck('while a stated 0 is still a stated lapse',
  Number((await dayOf('Meditate', '2026-02-05'))?.value) === 0 &&
  Number((await dayOf('Meditate', '2026-02-06'))?.value) === 2,
  JSON.stringify((await habitNamed('Meditate')).entries));
ck('and a quoted amount is still an amount',
  Number((await dayOf('Water', '2026-02-07'))?.value) === 8,
  JSON.stringify(await dayOf('Water', '2026-02-07')));

/* ---------- merging the same file twice adds nothing ---------- */

console.log('\n--- merge idempotency, including past the name clamp ---');

await wipe(alice);

// Restoring twice is the normal way to check a backup is good — this writer's
// own header says so, and the `willAdd` accounting above is built on it. The
// lookup asked for the RAW name while the INSERT wrote the clamped one, so for
// any name over LIMITS.name nothing ever matched: three merges of one file left
// three habits carrying one identical visible name, and `willAdd` counted each
// of them against MAX_HABITS_PER_USER as a fresh addition. No whitespace in it,
// so the stored name is exactly the first LIMITS.name characters.
const longName = 'Read-a-chapter-of-something-long-'.repeat(5)
  .slice(0, LIMITS.name + 50);
const longNameFile = {
  version: 1, app: 'habiterall',
  habits: [{
    name: longName, type: 'boolean',
    entries: [{ date: '2026-01-05', value: 2, status: '', notes: '' }],
  }],
};

const longMerges = [];
for (let i = 0; i < 3; i++) {
  longMerges.push(await applyImport(alice, parseHabiterallJSON(longNameFile), 'merge'));
}
const byLongName = (await read(alice))
  .filter((h) => h.name === longName.slice(0, LIMITS.name));

ck('a name past the clamp is created once and merged into thereafter',
  longMerges[0].habitsCreated === 1 &&
  longMerges[1].habitsCreated === 0 && longMerges[1].habitsMerged === 1 &&
  longMerges[2].habitsCreated === 0 && byLongName.length === 1,
  JSON.stringify(longMerges.map((r) => [r.habitsCreated, r.habitsMerged])));

/* ---------- a merge never renames or recolours a category ---------- */

console.log('\n--- category resolution on import ---');

await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');

// Give the account's own "Health" a colour the file below does not have, the
// same way a user would through the picker's manage list.
const healthBefore = (await categoriesOf(alice)).find((c) => c.name === 'Health');
await withUser(alice, (db) => db.query(
  `UPDATE categories SET color = $1 WHERE id = $2`, ['#123456', healthBefore.id]));

// A file that names the same category, by the same folded name, in a
// different colour, and adds a new habit under it.
const healthMergeFile = {
  version: 1, app: 'habiterall',
  categories: [{ name: 'health', color: '#ff0000', position: 0 }],
  habits: [{ name: 'Yoga', type: 'boolean', category: 'health', entries: [] }],
};
await applyImport(alice, parseHabiterallJSON(healthMergeFile), 'merge',
  backupCategories(Buffer.from(JSON.stringify(healthMergeFile), 'utf8')) ?? []);
const afterMerge2 = await categoriesOf(alice);

ck('a merge does not recolour a category that already exists',
  afterMerge2.filter((c) => c.name === 'Health').length === 1 &&
  afterMerge2.find((c) => c.name === 'Health').color === '#123456',
  JSON.stringify(afterMerge2));
const yoga = (await read(alice)).find((h) => h.name === 'Yoga');
ck('and the new habit still resolves to the existing category, by folded name',
  yoga.category_id === healthBefore.id, JSON.stringify(yoga));

// A replace has nothing to preserve: the file's own categories become the
// account's, spelling and colour included — 'health', not 'Health', because
// a replace adopts the file's own name rather than the account's prior one.
await wipe(alice);
await applyImport(alice, parseHabiterallJSON(healthMergeFile), 'replace',
  backupCategories(Buffer.from(JSON.stringify(healthMergeFile), 'utf8')) ?? []);
const afterReplace2 = await categoriesOf(alice);
ck("a replace applies the file's colour",
  afterReplace2.length === 1 && afterReplace2[0].name === 'health' &&
  afterReplace2[0].color === '#ff0000',
  JSON.stringify(afterReplace2));

await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');

/* ---------- a category's declared position survives a restore ---------- */

console.log('\n--- category position on import ---');

// Declared out of the order they are LISTED in the array, on purpose: if the
// importer ignored `position` and simply appended each in array order (the
// bug this section exists to catch), the categories would come back Zeta,
// Alpha, Mid — the array's own order — and an assertion comparing against
// that same order would pass whether or not `position` was ever read. Sorted
// by the POSITION field the file actually states, the right order is
// Alpha, Mid, Zeta.
const positionedFile = {
  version: 1, app: 'habiterall',
  categories: [
    { name: 'Zeta', color: '#3b82f6', position: 2 },
    { name: 'Alpha', color: '#22c55e', position: 0 },
    { name: 'Mid', color: '#ef4444', position: 1 },
  ],
  habits: [
    // Named only in a habit's own `category` field, so it never appears in
    // the `categories` array above and so declares no position at all — it
    // must still append, after every declared one.
    {
      name: 'Undeclared', type: 'boolean',
      category: 'Undeclared Category', entries: [],
    },
  ],
};
await wipe(alice);
await applyImport(alice, parseHabiterallJSON(positionedFile), 'replace',
  backupCategories(Buffer.from(JSON.stringify(positionedFile), 'utf8')) ?? []);
const positioned = await categoriesOf(alice);

ck('a category restores at the position the file declared, not the order it was listed',
  positioned.map((c) => c.name).join(',') === 'Alpha,Mid,Zeta,Undeclared Category',
  JSON.stringify(positioned.map((c) => [c.name, c.position])));

await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');

// The settings half of a backup, which only this edition stores as JSONB under
// RLS. `portableSettings` is what keeps a capability out of the file in both
// directions — the notification keys are absent by design.
//
// `detailCards` is set directly by raw SQL here rather than through the API,
// so it bypasses `parseCardList` entirely — `portableSettings` must carry
// whatever shape is stored, not normalise it. The fixture is still a
// non-canonical order with two cards off, and in two dimensions at once: its
// default is all nine ids ON in `DETAIL_CARDS` order, so a fixture varying
// only WHICH ids are on and left in canonical order would compare equal with
// the order silently dropped — the "fixture holds a field's default" defect,
// one axis short of catching it.
//
// Note what this does NOT cover, so nobody assumes it does: the value goes in
// through a raw `UPDATE ... jsonb` below and comes back through
// `portableSettings`, which only picks keys — `parseCardList` is never on this
// path. Personal's copy of this fixture goes through a real `PUT
// /api/settings` and so pins the normaliser too. This one is about the export
// carrying a stored shape unnormalised, which is a different claim.
const nonCanonicalDetailCards = [
  { id: 'history', on: true }, { id: 'calendar', on: true },
  { id: 'strength', on: false }, { id: 'recentDays', on: true },
  { id: 'frequency', on: true },
  { id: 'weekdays', on: false }, { id: 'awards', on: true },
  { id: 'streaks', on: true }, { id: 'resilience', on: true },
  { id: 'weekdayMonths', on: true },
];
await withUser(alice, (db) => db.query(
  `UPDATE users SET settings = $1::jsonb WHERE id = $2`,
  [JSON.stringify({
    skipDays: true, questionMarks: true, atMostUnlogged: 'success',
    // Not the registry default, or this compares 'system' with 'system'
    // and passes with `theme` dropped from PORTABLE_SETTINGS.
    theme: 'dark',
    // Likewise, and this one decides what the NEXT typed amount MEANS rather
    // than how anything is drawn: `10.000` is ten under one and a refused
    // thousands group under the other.
    numberFormat: 'comma',
    gridDays: '7',
    detailCards: nonCanonicalDetailCards,
    discordWebhook: 'https://discord.com/api/webhooks/1/secret',
  }), alice]
));

const exported = portableSettings(await withUser(alice, (db) =>
  db.query(`SELECT settings FROM users WHERE id = $1`, [alice])
    .then((r) => r.rows[0]?.settings ?? {})));

ck('a backup carries the tracking settings',
  exported.skipDays === true && exported.questionMarks === true &&
  // The third of them, and the one that changes an arithmetic rather than a
  // drawing: restore the rows without it and a limit's streaks come back
  // different from the ones that were exported.
  exported.atMostUnlogged === 'success' && exported.theme === 'dark' &&
  exported.numberFormat === 'comma' &&
  // The two display preferences from #112. Neither changes what a row means,
  // which is exactly why they are asserted: "portable" is a decision made once
  // in a list, and a key that quietly stopped travelling would show up only as
  // a page that came back longer than it was left.
  exported.gridDays === '7' &&
  JSON.stringify(exported.detailCards) === JSON.stringify(nonCanonicalDetailCards),
  JSON.stringify(exported));
ck('and no notification destination',
  !Object.keys(exported).some((k) => k.startsWith('discord') || k.startsWith('notify')),
  JSON.stringify(exported));

const fromFile = parseSettings(portableSettings({
  questionMarks: false,
  discordWebhook: 'https://discord.com/api/webhooks/999/attacker',
})).accepted;
await withUser(alice, (db) => db.query(
  `UPDATE users SET settings = settings || $1::jsonb WHERE id = $2`,
  [JSON.stringify(fromFile), alice]
));
const nowStored = await withUser(alice, (db) =>
  db.query(`SELECT settings FROM users WHERE id = $1`, [alice])
    .then((r) => r.rows[0]?.settings ?? {}));

ck('an uploaded file can set a display preference',
  nowStored.questionMarks === false, JSON.stringify(nowStored.questionMarks));
ck('but cannot repoint the reminders',
  nowStored.discordWebhook === 'https://discord.com/api/webhooks/1/secret',
  String(nowStored.discordWebhook));

// Back to the fixture for the format sections below.
await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');

/* ---------- Loop .db ---------- */

console.log('\n--- Loop .db backup ---');

const loopPath = join(tmpdir(), `habiterall-rt-${process.pid}.db`);
await writeLoopDatabase(loopPath, seeded, (id) =>
  seeded.find((h) => h.id === id)?.entries ?? []);
const loopBytes = readFileSync(loopPath);
ck('the Loop export is a SQLite file',
  loopBytes.subarray(0, 15).toString() === 'SQLite format 3');

const loopHabits = await parseLoopDatabase(loopPath);
await wipe(alice);
const loopResult = await applyImport(alice, loopHabits, 'replace');
const afterLoop = snapshot(await read(alice), { fields: LOOP_DB_HABIT_FIELDS });
try { unlinkSync(loopPath); } catch { /* best effort */ }

// Every entry, with no exception left: Loop's NO is a day habiterall can both
// hold and write now, so a stated lapse survives whether or not a note came with
// it. The note itself is inside this comparison now — `Repetitions.notes` is a
// real column both halves of the round trip have always used, and the fixture
// header said otherwise for long enough that dropping it would have failed
// nothing. Only Checkmarks.csv genuinely cannot carry one.
ck('Loop round-trip preserves habits and entries',
  diff(baselineLoopDb, afterLoop) === null,
  diff(baselineLoopDb, afterLoop) ?? '');
ck('Loop restore skipped nothing',
  loopResult.skipped.length === 0, loopResult.skipped.join('; '));

const loopMeditate = afterLoop.find((h) => h.name === 'Meditate');
// The trailing field is the note, which this comparison now carries — so this
// asserts the lapse AND the text on it, where before it asserted neither for
// the noted one.
ck('Loop: a stated lapse survives, with or without a note',
  statedLapses().every((e) => loopMeditate.entries.includes(`${e.date}|0||${e.notes}`)),
  loopMeditate.entries.join(' '));

const loopWater = afterLoop.find((h) => h.name === 'Water');
ck('Loop: numerical 3 stays 3, not a skip',
  loopWater.entries.includes('2026-01-06|3||busy day'), loopWater.entries.join(' '));
ck('Loop: target values are not scaled by 1000',
  loopWater.target_value === 8, String(loopWater.target_value));

// Loop's reminder_hour / reminder_min and its `question`, both of which were
// written as literal NULL / '' on the way out and never read on the way in.
ck('Loop: a reminder time survives',
  loopMeditate.reminder_time === '07:30', String(loopMeditate.reminder_time));
ck('Loop: a midnight reminder is a reminder, not a blank',
  afterLoop.find((h) => h.name === 'Snacks').reminder_time === '00:00',
  String(afterLoop.find((h) => h.name === 'Snacks').reminder_time));
ck('Loop: no reminder stays no reminder',
  afterLoop.find((h) => h.name === 'Reading').reminder_time === '',
  JSON.stringify(afterLoop.find((h) => h.name === 'Reading').reminder_time));
ck('Loop: the reminder prompt survives as question',
  loopMeditate.reminder_message === 'Did you sit for ten minutes?',
  String(loopMeditate.reminder_message));

// The three the fixture header called impossible. Named one at a time as well
// as being inside the comparison above, because "the .db cannot carry this" is
// the claim that kept them out, and a diff line is a poor place to read a
// refutation of it.
ck('Loop: the description survives',
  loopMeditate.description === 'Ten minutes, morning', String(loopMeditate.description));
ck('Loop: archived state survives',
  afterLoop.find((h) => h.name === 'Reading').archived === true &&
  loopMeditate.archived === false,
  `Reading=${afterLoop.find((h) => h.name === 'Reading').archived} Meditate=${loopMeditate.archived}`);
ck('Loop: a per-day note survives, on a done day and on a lapse',
  loopMeditate.entries.includes('2026-01-06|2||felt good') &&
  loopMeditate.entries.includes('2026-01-08|0||overslept'),
  loopMeditate.entries.join(' '));

// The gap `icon` belongs to no Loop list: it is stated on the way in and read
// back afterwards, rather than assumed, and guarded so it cannot pass on a
// fixture with nothing to lose.
const iconHabits = habitsWithIcon();
ck('the fixture declares an icon on more than zero habits',
  iconHabits.length > 0, String(iconHabits.length));

const afterLoopFull = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });
ck('Loop: the restored habits carry an icon KEY at all',
  afterLoopFull.every((h) => Object.hasOwn(h, 'icon')),
  afterLoopFull.map((h) => `${h.name}:${Object.hasOwn(h, 'icon')}`).join(' '));
ck('Loop: every restored habit has icon === \'\', the format has nowhere to put one',
  afterLoopFull.every((h) => h.icon === ''),
  afterLoopFull.map((h) => `${h.name}:${JSON.stringify(h.icon)}`).join(' '));

/* ---------- CSV archive ---------- */

console.log('\n--- CSV archive (Habits.csv + Checkmarks.csv) ---');

// `seeded` is the snapshot taken right after `seed(alice)`, before any of the
// sections above overwrote the account's categories through their own
// replace-mode restores — so `FIXTURE_CATEGORIES` (what `seed` actually wrote
// into `categories`) is what this archive's own colours and positions have to
// be built from, the same way `seeded` itself stands in for what `/export.csv`
// would have served at that moment.
const csvZip = buildCsvArchive(seeded, (id) =>
  seeded.find((h) => h.id === id)?.entries ?? [], FIXTURE_CATEGORIES);
const members = unzip(csvZip);
ck('the archive contains both CSVs',
  members.has('Habits.csv') && members.has('Checkmarks.csv'),
  [...members.keys()].join(', '));
ck('and now Categories.csv too, since this account has categories',
  members.has('Categories.csv'), [...members.keys()].join(', '));

const meta = parseLoopHabitsCSV(members.get('Habits.csv').toString('utf8'));
const csvHabits = parseLoopCheckmarksCSV(members.get('Checkmarks.csv').toString('utf8'), meta);

await wipe(alice);
const csvResult = await applyImport(
  alice, csvHabits, 'replace', backupCategories(csvZip) ?? []);
const afterCsv = snapshot(await read(alice), { fields: CSV_HABIT_FIELDS, notes: false });

ck('CSV round-trip preserves habits and entries',
  diff(baselineCsv, afterCsv) === null,
  diff(baselineCsv, afterCsv) ?? '');
ck('CSV restore skipped nothing',
  csvResult.skipped.length === 0, csvResult.skipped.join('; '));

const csvMeditate = afterCsv.find((h) => h.name === 'Meditate');
ck('CSV: a stated lapse survives as a NO cell',
  statedLapses().every((e) => csvMeditate.entries.includes(`${e.date}|0|`)),
  csvMeditate.entries.join(' '));

const csvWater = afterCsv.find((h) => h.name === 'Water');
ck('CSV: a numerical 3 stays 3, not a skip',
  csvWater.entries.includes('2026-01-06|3|'), csvWater.entries.join(' '));
ck('CSV: large amounts are not dropped as unknown sentinels',
  csvWater.entries.includes('2026-01-05|8|') && csvWater.entries.includes('2026-01-07|10|'),
  csvWater.entries.join(' '));

// Habits.csv wrote the description into Question as well as Description, and
// the importer read Question as a fallback FOR description — so the duplication
// was invisible and the prompt was lost. The two columns are two fields.
const csvFull = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });
const csvFullMeditate = csvFull.find((h) => h.name === 'Meditate');
ck('CSV: the reminder prompt survives, in the Question column',
  csvFullMeditate.reminder_message === 'Did you sit for ten minutes?',
  String(csvFullMeditate.reminder_message));
ck('CSV: the description is not overwritten by the prompt',
  csvFullMeditate.description === 'Ten minutes, morning', csvFullMeditate.description);
// Loop's CSV export has no reminder columns at all, so this one is expected to
// be dropped — asserted rather than assumed, since it is the difference between
// the two Loop formats and the reason there are two field lists.
ck('CSV: a reminder time is dropped, as the format requires',
  csvFullMeditate.reminder_time === '', JSON.stringify(csvFullMeditate.reminder_time));

ck('CSV: the restored habits carry an icon KEY at all',
  csvFull.every((h) => Object.hasOwn(h, 'icon')),
  csvFull.map((h) => `${h.name}:${Object.hasOwn(h, 'icon')}`).join(' '));
ck('CSV: every restored habit has icon === \'\', the format has nowhere to put one',
  csvFull.every((h) => h.icon === ''),
  csvFull.map((h) => `${h.name}:${JSON.stringify(h.icon)}`).join(' '));

// The property this step exists to add: `CSV_HABIT_FIELDS` only ever pinned
// the per-habit ASSIGNMENT (which habit belongs to which named category); a
// category's own colour and declared position ride on Categories.csv now, and
// are checked here against `FIXTURE_CATEGORIES` — whose own comment says why
// neither value is one a naive re-creation could produce by accident.
const csvCategories = await categoriesOf(alice);
for (const cat of FIXTURE_CATEGORIES) {
  const restored = csvCategories.find((c) => c.name === cat.name);
  ck(`CSV: "${cat.name}"'s colour survives the zip round trip`,
    restored?.color === cat.color,
    `expected ${cat.color} got ${JSON.stringify(restored)}`);
  ck(`CSV: "${cat.name}"'s declared position survives the zip round trip`,
    restored?.position === cat.position,
    `expected ${cat.position} got ${JSON.stringify(restored)}`);
}

/* ---------- a zip merge never renames or recolours a category ---------- */

console.log('\n--- category resolution on a zip import ---');

await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');

// Give the account's own "Health" a colour a Categories.csv below does not
// carry — same setup as the JSON version of this test above, now proving
// decision 5 (docs/decisions/categories.md) holds through the zip path too,
// not only the JSON one. `resolveOrCreateCategory` is the premise this whole
// step's plan rests on: it must return the existing id rather than recolour
// it, whichever format asked.
const zipHealthBefore = (await categoriesOf(alice)).find((c) => c.name === 'Health');
await withUser(alice, (db) => db.query(
  `UPDATE categories SET color = $1 WHERE id = $2`, ['#654321', zipHealthBefore.id]));

// A zip naming the same category, by the same folded name, in a different
// colour, and adding a new habit under it.
const healthMergeZip = buildCsvArchive(
  [{ id: 1, name: 'Yoga', category: 'health' }], () => [],
  [{ name: 'health', color: '#ff00ff', position: 0 }],
);
const zipMergeMembers = unzip(healthMergeZip);
const zipMergeMeta = parseLoopHabitsCSV(zipMergeMembers.get('Habits.csv').toString('utf8'));
const zipMergeHabits = parseLoopCheckmarksCSV(
  zipMergeMembers.get('Checkmarks.csv').toString('utf8'), zipMergeMeta);
const zipMergeResult = await applyImport(
  alice, zipMergeHabits, 'merge', backupCategories(healthMergeZip) ?? []);
const afterZipMerge = await categoriesOf(alice);

ck('a zip merge does not recolour a category that already exists',
  afterZipMerge.filter((c) => c.name === 'Health').length === 1 &&
  afterZipMerge.find((c) => c.name === 'Health').color === '#654321',
  JSON.stringify(afterZipMerge));
ck('and the merge created the new habit',
  zipMergeResult.habitsCreated === 1, JSON.stringify(zipMergeResult));

const zipYoga = (await read(alice)).find((h) => h.name === 'Yoga');
ck('and the new habit still resolves to the existing category, by folded name',
  zipYoga.category_id === zipHealthBefore.id, JSON.stringify(zipYoga));

/* ---------- tenancy: a restore stays in its own account ---------- */

console.log('\n--- tenancy ---');

// Bob restores Alice's backup, ids and all. It must become Bob's own copy and
// must not touch a single row of Alice's — the ids in the file are ignored by
// design, and RLS is the backstop if that ever regresses.
await wipe(alice);
await applyImport(alice, parseHabiterallJSON(jsonBackup), 'replace');
const aliceBefore = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });

await applyImport(bob, parseHabiterallJSON(jsonBackup), 'replace');

const aliceAfter = snapshot(await read(alice), { fields: JSON_HABIT_FIELDS });
const bobAfter = snapshot(await read(bob), { fields: JSON_HABIT_FIELDS });

ck("importing as Bob leaves Alice's data untouched",
  diff(aliceBefore, aliceAfter) === null,
  diff(aliceBefore, aliceAfter) ?? '');
ck('Bob gets his own faithful copy',
  diff(baselineFull, bobAfter) === null,
  diff(baselineFull, bobAfter) ?? '');

// The rows really are distinct, not shared: no habit id appears in both.
const ids = async (u) => new Set((await read(u)).map((h) => String(h.id)));
const aliceIds = await ids(alice);
const bobIds = await ids(bob);
ck('the two accounts share no habit rows',
  [...bobIds].every((id) => !aliceIds.has(id)),
  `alice=${aliceIds.size} bob=${bobIds.size}`);

// A replace-mode restore must scope its wipe to the importer.
ck("Bob's replace did not delete Alice's habits",
  aliceIds.size === FIXTURE.length, `${aliceIds.size} habits`);

/* ---------- done ---------- */

await admin.query('DELETE FROM entries');
await admin.query('DELETE FROM habits');
await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'rt-%'`);
await admin.end();
await pool.end();

console.log(`\n${fails === 0 ? 'all round-trip checks passed' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
