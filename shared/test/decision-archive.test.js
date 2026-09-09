import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The decision archive is reachable: every record indexed, every pointer real.
 *
 * `docs/decisions/` is not loaded into context, so the only way anybody arrives
 * at a record is by being pointed at one — the index table in
 * `docs/decisions/README.md`, or the "Where the rest is written down" table in
 * the root `CLAUDE.md`. Until this file existed nothing checked either
 * direction: deleting a record AND its one index row left `npm test` and
 * `npm run site:build -- --offline` both green, which makes "add a row so it is
 * reachable" an instruction with nothing behind it. A record nobody can find is
 * a record that gets re-derived, usually wrongly — the archive exists precisely
 * because the second derivation is the expensive one.
 *
 * Nothing here is a list of filenames. The directory is the source of truth for
 * what records exist and the two tables are read as they are written, so a
 * record added tomorrow is covered the day it lands and not the day somebody
 * remembers this file.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARCHIVE = join(root, 'docs', 'decisions');

/**
 * The index is not one of the records it indexes.
 *
 * This is definitional rather than an exemption: `README.md` is the file being
 * READ as the index below, so asking it to contain a row about itself is asking
 * the table to list the table. Any other non-record would need a reason of its
 * own here, in the shape `notMirrored` uses — a map entry carrying why, not a
 * name on a skip list. Compared case-folded, and then asserted to match exactly
 * one entry, so "the index" cannot quietly become two files.
 */
const INDEX = 'README.md';
const isIndex = (name) => name.toLowerCase() === INDEX.toLowerCase();

/** A record's filename, whatever case its extension is written in. */
const isRecordName = (name) => /\.md$/i.test(name) && !isIndex(name);

const entries = readdirSync(ARCHIVE, { withFileTypes: true });

/** Every record in the archive, spelled as it is on disk. */
const records = entries
  .filter((e) => e.isFile() && isRecordName(e.name))
  .map((e) => e.name)
  .sort();

/** Lowercased filename -> the spelling on disk, for the resolver below. */
const byFold = new Map(records.map((f) => [f.toLowerCase(), f]));

/**
 * Resolve a filename a table wrote to the record it means.
 *
 * Case-folded, because a record named `rogue.MD` used to satisfy all three
 * assertions here — it needed no index row, was never checked for reachability,
 * and defeated the whole file by a wrong-case extension. Folded matching must
 * not then HIDE a real case mismatch, though: `Awards.MD` in a row is a broken
 * link on any case-sensitive checkout and in GitHub's own rendering, so it
 * resolves and is reported as miscased rather than passing as a hit.
 */
function resolve(name) {
  const actual = byFold.get(name.toLowerCase());
  if (!actual) return { missing: name };
  if (actual !== name) return { miscased: `${name} (on disk: ${actual})` };
  return { ok: actual };
}

/** A GFM delimiter row: the `|---|---|` under a table's header. */
const RULE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

/**
 * The body rows of ONE markdown table, found by its header's first cell.
 *
 * Three things about the slicing, each of which was wrong in a first version.
 * The header is located by its first cell rather than assumed to be the first
 * `|` line, so a table that has moved fails instead of mis-slicing silently.
 * The row after it must be a `|---|` rule, which is what makes this a table
 * and not a pipe-shaped line inside a fence. And the rows are the CONTIGUOUS
 * run below that rule, not every `|` line in the file: filtering the whole
 * file meant a second, unrelated table anywhere below — or an indented row in
 * a code block — was read as a row of this one, which failed loudly but blamed
 * the row instead of the reader.
 */
function tableRows(lines, header) {
  const start = lines.findIndex((l) => l.trimStart().startsWith('|') && cells(l)[0] === header);
  assert.notEqual(start, -1,
    `no table here has a first column headed ${JSON.stringify(header)} — the table has been renamed or moved, and this guard was reading nothing`);
  assert.match(lines[start + 1] ?? '', RULE,
    `the line under the ${JSON.stringify(header)} header is not a |---| rule, so this is not the table it looks like: ${JSON.stringify(lines[start + 1] ?? null)}`);

  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trimStart().startsWith('|')) break;
    rows.push(line);
  }
  return rows;
}

/** A table row's cells, trimmed, without the leading and trailing pipe. */
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Every `` `name.md` `` in a cell, with an optional `docs/decisions/` prefix stripped. */
function archiveNames(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((name) => /\.md$/i.test(name))
    .map((name) => name.replace(/^docs\/decisions\//i, ''));
}

/**
 * The index table's rows, parsed on first use and not at module scope.
 *
 * At module scope a malformed table throws while the file is LOADING, which
 * fails every test here at once and reports the filename instead of the check —
 * the reason for the failure is still printed, but the three assertions below
 * are hidden behind the one that noticed.
 */
let indexRowsCache = null;
function indexRows() {
  if (!indexRowsCache) {
    const lines = readFileSync(join(ARCHIVE, INDEX), 'utf8').split('\n');
    indexRowsCache = tableRows(lines, 'file');
  }
  return indexRowsCache;
}

test('the archive is flat, and the index is the one file in it that is not a record', () => {
  // A subdirectory is the other way to add a record nothing points at:
  // `docs/decisions/sub/hidden.md` is invisible to a non-recursive read, and
  // every assertion below would stay green with it there. Flat is the
  // invariant rather than the accident — both tables name a record by a bare
  // filename, and `docs/decisions/sub/hidden.md` has no spelling either of
  // them could carry — so this fails on a directory instead of recursing into
  // one, which is the smaller assertion and refuses the shape outright.
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(dirs, [],
    'docs/decisions/ has subdirectories, and the archive is flat: both index tables name records by a bare filename, so nothing under one of these can be pointed at: '
    + dirs.join(', '));

  // And the index exemption is definitional only while exactly one file is it.
  const indexes = entries.filter((e) => e.isFile() && isIndex(e.name)).map((e) => e.name);
  assert.deepEqual(indexes, [INDEX],
    `exactly one file in docs/decisions/ may be the index, and it is read as ${INDEX}; found: ${indexes.join(', ') || 'none'}`);
});

test('every record in docs/decisions/ has a row in the index', () => {
  // The direction that catches a record arriving with no pointer to it.
  const indexed = new Set(
    indexRows().flatMap((row) => archiveNames(cells(row)[0])).map((n) => n.toLowerCase()));
  const unlisted = records.filter((f) => !indexed.has(f.toLowerCase()));
  assert.deepEqual(unlisted, [],
    'these records are in docs/decisions/ but have no row in docs/decisions/README.md: '
    + unlisted.join(', '));
});

test('every row in the index names a record that exists', () => {
  // And the direction that catches a record deleted or renamed out from under
  // its row. Each row's first cell has to parse, so a row that is not shaped
  // like an index row fails here rather than being skipped into a pass.
  const rows = indexRows();
  assert.ok(rows.length >= 22,
    `the index has ${rows.length} rows, which is fewer than the 22 it had when this guard was written — the table is being read wrongly, or rows have gone`);

  const missing = [];
  const miscased = [];
  for (const row of rows) {
    const named = archiveNames(cells(row)[0]);
    assert.equal(named.length, 1,
      `this index row does not name exactly one record file: ${row.trim()}`);
    const r = resolve(named[0]);
    if (r.missing) missing.push(r.missing);
    if (r.miscased) miscased.push(r.miscased);
  }
  assert.deepEqual(missing, [],
    'docs/decisions/README.md has rows for records that are not in the repo: ' + missing.join(', '));
  assert.deepEqual(miscased, [],
    'docs/decisions/README.md spells these records in a case the files do not use, which is a broken link on a case-sensitive checkout: '
    + miscased.join(', '));
});

test("every archive file the root CLAUDE.md points at exists", () => {
  // The third column of "Where the rest is written down" is prose listing
  // filenames, which is the part that can quietly match nothing — and a guard
  // whose extraction finds zero names passes vacuously. So the denominator is
  // asserted twice over: the section has to be found, and EVERY row in it has
  // to yield at least one filename. A regex that stops seeing the bare
  // `awards.md` form still sees row one's `docs/decisions/day-states.md`, so a
  // total count alone would not catch it; a per-row floor does.
  const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8').split('\n');
  const heading = claude.indexOf('## Where the rest is written down');
  assert.notEqual(heading, -1,
    'the root CLAUDE.md has no "## Where the rest is written down" section — it has been renamed, and this guard checks nothing until it is pointed at the new heading');

  const after = claude.slice(heading + 1);
  const nextHeading = after.findIndex((l) => l.startsWith('## '));
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);

  const rows = tableRows(section, 'working in');
  assert.ok(rows.length >= 10,
    `the pointer table has ${rows.length} rows, fewer than the 10 it had when this guard was written`);

  const found = [];
  for (const row of rows) {
    const cs = cells(row);
    assert.equal(cs.length, 3, `this pointer row has ${cs.length} columns, not 3: ${row.trim()}`);
    const named = archiveNames(cs[2]);
    assert.ok(named.length > 0,
      `no archive filename could be read out of this row's third column, so the extraction is broken rather than the row empty: ${row.trim()}`);
    found.push(...named);
  }

  // What the assertions above are worth, printed: an empty offender list means
  // nothing until the denominator is known.
  const pointed = new Set(found.map((f) => f.toLowerCase()));
  const unpointed = records.filter((f) => !pointed.has(f.toLowerCase()));
  console.log(`      CLAUDE.md pointer table: ${rows.length} rows, `
    + `${found.length} archive filenames (${new Set(found).size} distinct); `
    + `${records.length} records on disk`);
  // Deliberately NOT asserted. Whether the pointer table should name every
  // record is a decision and not a defect — it points at what an area needs,
  // and `ntfy-answers.md` is reached from `shared/CLAUDE.md`'s ntfy section
  // instead. What it costs to leave unasserted is that a record can quietly
  // stop being pointed at from here, so the number is printed: the stale claim
  // this file's own commit message made about which records are absent is
  // exactly what a printed inventory would have caught.
  console.log(`      records with no row in that table (not asserted on): `
    + `${unpointed.length ? unpointed.join(', ') : 'none'}`);

  assert.ok(found.length >= 28,
    `only ${found.length} archive filenames were read out of the pointer table, fewer than the 28 there when this guard was written`);

  const missing = [];
  const miscased = [];
  for (const name of new Set(found)) {
    const r = resolve(name);
    if (r.missing) missing.push(r.missing);
    if (r.miscased) miscased.push(r.miscased);
  }
  assert.deepEqual(missing.sort(), [],
    "the root CLAUDE.md's pointer table names archive files that do not exist: " + missing.join(', '));
  assert.deepEqual(miscased.sort(), [],
    "the root CLAUDE.md's pointer table spells these records in a case the files do not use: "
    + miscased.join(', '));
});
