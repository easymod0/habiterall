import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

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
 * The same, plus the index — what a `docs/decisions/…` PATH may name.
 *
 * The two tables may only point at records, so they resolve against `byFold`.
 * A reference written out in prose or in a comment is a path rather than a row,
 * and `docs/decisions/README.md` is a real file that a paragraph can honestly
 * send somebody to, so the sweep resolves against this one instead.
 */
const archiveByFold = new Map(
  entries.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => [e.name.toLowerCase(), e.name]));

/**
 * Resolve a filename a table or a paragraph wrote to the file it means.
 *
 * Case-folded, because a record named `rogue.MD` used to satisfy all three
 * assertions here — it needed no index row, was never checked for reachability,
 * and defeated the whole file by a wrong-case extension. Folded matching must
 * not then HIDE a real case mismatch, though: `Awards.MD` in a row is a broken
 * link on any case-sensitive checkout and in GitHub's own rendering, so it
 * resolves and is reported as miscased rather than passing as a hit.
 */
function resolve(name, within = byFold) {
  const actual = within.get(name.toLowerCase());
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
 * Directories the repo-wide sweep does not enter, each carrying why.
 *
 * A map rather than a set, the shape `notMirrored` uses, because every one of
 * these is a decision about what this repository IS and not a name that was
 * inconvenient. Matched on the path from the root and also on the bare name,
 * and against files as well as directories: a nested `node_modules` needs the
 * second, and in a git WORKTREE — which is where the agents that maintain this
 * repo run — `.git` is a one-line file rather than a directory.
 */
const NOT_SWEPT = new Map([
  ['.git', 'version-control internals: packfiles, and every deleted line of every branch'],
  ['node_modules', 'installed dependencies — not this repository, and tens of thousands of files'],
  ['.claude/work', 'agent scratch: briefs and review notes, untracked, and routinely written ABOUT a record mid-rename, so a reference in one is not a claim the repo makes'],
  ['.claude/worktrees', 'a second CHECKOUT of this same repository — its files belong to another branch, and walking one from the other reads the wrong tree'],
  ['site/dist', 'generated by npm run site:build, not committed'],
  ['coverage', 'generated'],
  ['android-native/build', 'Gradle output'],
  ['android-native/app/build', 'Gradle output'],
  ['android-native/.gradle', 'Gradle caches'],
]);

/**
 * Every file in the repository the sweep will read, as paths from the root.
 *
 * A directory that cannot be READ — permissions, a broken mount, a race with
 * something deleting it — is collected into `unreadable` and walked past,
 * rather than thrown out of the middle of the walk. The throw was the wrong
 * failure for a guard whose whole subject is failing loudly: it escapes as a
 * crash naming `readdirSync`, which reports the stack instead of the check.
 *
 * Collecting is not the same as tolerating, and the caller asserts the list is
 * empty. Leaning on the floors below instead would not work and it is worth
 * saying why, because it is the tempting version: they sit ~100 files under
 * the real count so ordinary work does not trip them, so a locked directory of
 * a dozen files clears every one of them and the sweep then reports an empty
 * offender list over a denominator it silently shrank — the exact shape this
 * file exists to refuse one directory over. And a floor that DID fire would
 * blame the walk for not recursing, which is a true sentence about the wrong
 * cause. The walk continues past one so the report can name every unreadable
 * directory rather than the first.
 */
function sweptFiles(dir = root, rel = '', out = [], unreadable = []) {
  let here;
  try {
    here = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // The code is carried because it is what tells the two apart: EACCES is a
    // permission this checkout has, ENOENT is the tree moving under the walk.
    unreadable.push(`${rel || '.'} (${err.code || err.message})`);
    return out;
  }
  for (const e of here.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (NOT_SWEPT.has(path) || NOT_SWEPT.has(e.name)) continue;
    // `isDirectory()` on a Dirent is false for a symlink, so a link out of the
    // tree — `node_modules/@habiterall/shared` is one — is never followed.
    if (e.isDirectory()) sweptFiles(join(dir, e.name), path, out, unreadable);
    else if (e.isFile()) out.push(path);
  }
  return out;
}

/**
 * A path spelling out the archive, which is unambiguous wherever it is written.
 *
 * `[A-Za-z0-9._-]+` deliberately excludes `/`, so `docs/decisions/sub/x.md`
 * does not match at all rather than matching something wrong — the archive is
 * asserted flat one test up, and a path claiming otherwise is that test's.
 */
const ARCHIVE_PATH = /docs\/decisions\/([A-Za-z0-9._-]+\.md)/gi;

/** A backticked filename, which is how every pointer file spells one. */
const BACKTICKED_MD = /`([^`\n]+\.md)`/gi;

/**
 * The same path CUT at the archive's own slash, which is how one is rewrapped.
 *
 * A line that ENDS in the archive's directory is the strong signal, and it is
 * strong because it is not a shape that occurs innocently: a sentence naming
 * the DIRECTORY spells it `` `docs/decisions/` `` and so ends in a backtick,
 * or carries on with the rest of its clause — the root `CLAUDE.md`'s own
 * "is in `docs/decisions/`, which is not loaded into context" is both. Ending
 * a line on the bare slash is a path whose filename went to the next line.
 *
 * This is deliberately NOT "join every comment line and re-match", which is
 * what #314 declined and was right to: joining lines makes a filename at the
 * head of any continuation into a reference, and a paragraph that happens to
 * open a line with `awards.md` is honest prose the guard would then fail on.
 * The signal here is the PREVIOUS line's ending, so the false-positive surface
 * is one line shape rather than every line.
 *
 * What it still cannot see is a path broken anywhere ELSE — `docs/deci` /
 * `sions/x.md`, or `day-` / `states.md`. Both wrapped references this repo has
 * break at the slash, which is where an editor and a person both wrap.
 */
const WRAPPED_PREFIX = /docs\/decisions\/[ \t]*$/;

/**
 * The record such a path resumes with, at the very head of the next line.
 *
 * The name has to be the FIRST thing on the continuation, after at most one
 * comment marker, because that is what a cut path looks like when it resumes;
 * anything else on the line first means the line is prose rather than the rest
 * of a path. The character class is `ARCHIVE_PATH`'s own, so the two forms
 * accept exactly the same filenames. No `NOT_A_RECORD` exemption, deliberately:
 * this is the path form, which may legitimately name `README.md`, and it
 * resolves against `archiveByFold` like every other path does.
 */
const CONTINUED_NAME = /^[ \t]*(?:\*|\/\/|#+|--|>)?[ \t]*([A-Za-z0-9._-]+\.md)/;
const continuedRecord = (line) => CONTINUED_NAME.exec(line)?.[1] ?? null;

/**
 * The files where a BARE `` `foo.md` `` is a reference to the archive.
 *
 * Nowhere else, and that is the whole of what keeps this sweep from being
 * noisy. A `CLAUDE.md` and a record are the two kinds of file whose job is to
 * point at the archive, and inside them the convention is already absolute:
 * every backticked markdown filename either spells a path or is one of the
 * names below. A bare filename in a source comment, in the root README or in
 * `.claude/skills/` is genuinely ambiguous, so those files are swept for the
 * PATH form only.
 */
const pointsAtTheArchive = (path) =>
  basename(path) === 'CLAUDE.md' || (path.startsWith('docs/decisions/') && /\.md$/i.test(path));

/**
 * The markdown filenames a pointer file may name bare that are not records.
 *
 * A map carrying reasons rather than a skip list, for the same reason
 * `NOT_SWEPT` is one. Compared folded, since this decides what is EXEMPT and a
 * `Readme.md` slipping past to be reported as a missing record is a confusing
 * failure rather than a useful one.
 *
 * The last four are not hypothetical, and they are why this exempts a NAME
 * rather than a file. `.claude/agents/` and `.claude/skills/` are swept for the
 * path form only, so none of them can fail from where it sits today — but each
 * is a real file in this repo whose name carries no directory part to tell it
 * apart from a record, and one sentence in a `CLAUDE.md` naming any of them
 * would be honest prose that this guard refused. Listing them makes that a
 * lookup instead of a bug report.
 */
const NOT_A_RECORD = new Map([
  ['claude.md', 'the working notes themselves — one per directory, and what these files ARE'],
  ['readme.md', "every package's own, and the root one the website is generated from"],
  ['setup.md', "habiterall-cloud's deployment guide"],
  ['skill.md', 'the entry file of a skill under .claude/skills/'],
  ['traps.md', "the pr-review skill's defect-class reference"],
  ['verify.md', "the pr-review skill's verification reference"],
  ['worker-brief.md', "the issue-to-pr skill's brief template"],
]);

/** A filename that could be a record: the shape `ARCHIVE_PATH` also accepts. */
const BARE_NAME = /^[A-Za-z0-9._-]+\.md$/i;

/**
 * What a backticked filename in a pointer file refers to, or null for nothing.
 *
 * **Anything carrying a directory part is refused outright, the archive's own
 * prefix included**, and that disjointness is load bearing rather than tidy.
 * This branch used to strip a `docs/decisions/` prefix and return the basename,
 * which made the two forms overlap on the one spelling both can read — and
 * since the per-line dedup lets a path hit overwrite a bare one, a break in the
 * PATH regex silently RE-COUNTED those references as bare and pushed the bare
 * figure UP, 64 to 79, while the path figure fell. Two floors that move in
 * opposite directions under one break are worth less than one floor. Refusing
 * the prefixed spelling here costs no coverage: `ARCHIVE_PATH` reads every file
 * in the repository, pointer files included.
 *
 * The SHAPE check is the other half, and it only restates the rule
 * `ARCHIVE_PATH` already makes in its character class. Without it this branch
 * accepted whatever sat before the `.md`, so one honest sentence about how to
 * add a record — naming the placeholder `<topic>.md`, or the glob `*.md` —
 * failed the guard by reporting two records that do not exist. The likeliest
 * author of that sentence is `docs/decisions/README.md` or the root `CLAUDE.md`
 * explaining this very directory: a pointer file, and so bare-swept. It also
 * subsumes the empty basename, which is why `` `.md` `` discussed as an
 * extension (`.github/workflows/README.md` does) no longer reads as a file.
 */
function backtickedRecord(text) {
  if (text.includes('/')) return null;
  if (!BARE_NAME.test(text)) return null;
  if (NOT_A_RECORD.has(text.toLowerCase())) return null;
  return text;
}

/**
 * Every archive reference in ONE file's text, which is the whole extraction.
 *
 * A function rather than the sweep's loop body because of the wrapped form: it
 * fires on two lines of this repository, so the only backstop the other forms
 * have — a floor over how many the sweep found — would sit AT the real figure
 * and fail the day somebody rewraps either comment, which is honest work and
 * would get the branch deleted. Handed two lines of its own instead, the
 * branch is pinned by construction, and there is one implementation for the
 * sweep to reach for rather than a second one written in the test beside it.
 *
 * @param {string} path the file's path from the root, which decides two things
 * @param {string} text its contents, already known not to be binary
 * @returns {{file: string, where: string, name: string, form: string, wrapped: boolean}[]}
 */
function referencesIn(path, text) {
  const refs = [];
  const bare = pointsAtTheArchive(path);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // Deduped per line, because a pointer file spells both forms of the same
    // reference on one line — the table's first row is
    // `docs/decisions/day-states.md`, then four bare names — and counting
    // that twice would inflate the inventory the floors are read off.
    // The PATH form wins the tie, since it is the form that was written, and
    // the three writes below are ordered by that rule: a name arriving as a
    // whole path on this line is not reported as a wrapped one.
    const named = new Map();
    if (bare) {
      for (const m of line.matchAll(BACKTICKED_MD)) {
        const name = backtickedRecord(m[1]);
        if (name) named.set(name, { form: 'bare', wrapped: false });
      }
    }
    // A path the PREVIOUS line cut at the archive's slash. Filed at the line
    // the filename is on rather than the one the path opened on: that is the
    // line a rename has to edit, and it is one line below what a grep for
    // `docs/decisions` prints.
    const carried = i > 0 && WRAPPED_PREFIX.test(lines[i - 1]) ? continuedRecord(line) : null;
    if (carried) named.set(carried, { form: 'path', wrapped: true });
    for (const m of line.matchAll(ARCHIVE_PATH)) named.set(m[1], { form: 'path', wrapped: false });
    for (const [name, { form, wrapped }] of named) {
      refs.push({ file: path, where: `${path}:${i + 1}`, name, form, wrapped });
    }
  });
  return refs;
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

  // A file here that is not markdown is neither a record nor an index row, and
  // every assertion in this file passes with one sitting there unmentioned.
  // Printed rather than asserted, deliberately: a diagram or a data file beside
  // the record that explains it is plausibly legitimate, so refusing one would
  // be this guard inventing a rule rather than enforcing one. What it costs to
  // leave unasserted is only visibility, and that is what the line buys —
  // exactly the reasoning behind the un-asserted inventory in the last test.
  const assets = entries.filter((e) => e.isFile() && !/\.md$/i.test(e.name)).map((e) => e.name).sort();
  console.log(`      ${records.length} records, 1 index, and non-markdown files beside them `
    + `(not asserted on): ${assets.length ? assets.join(', ') : 'none'}`);
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
  const rowsFor = new Map();
  for (const row of rows) {
    const named = archiveNames(cells(row)[0]);
    assert.equal(named.length, 1,
      `this index row does not name exactly one record file: ${row.trim()}`);
    const r = resolve(named[0]);
    if (r.missing) missing.push(r.missing);
    if (r.miscased) miscased.push(r.miscased);
    // A set difference cannot see a record listed twice: both directions above
    // are satisfied by two rows for one record, and the table then says two
    // different things about it — which is worse than saying nothing, because
    // a reader who finds the first row never learns there is a second. Counted
    // FOLDED, so `Awards.md` and `awards.md` are one record with two rows
    // rather than one of each (the miscasing is reported separately below).
    const fold = named[0].toLowerCase();
    rowsFor.set(fold, (rowsFor.get(fold) ?? 0) + 1);
  }
  const duplicated = [...rowsFor].filter(([, n]) => n > 1).map(([f, n]) => `${f} (${n} rows)`);
  assert.deepEqual(duplicated, [],
    'these records have more than one row in docs/decisions/README.md, so the index says two things about one file: '
    + duplicated.join(', '));

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
    // Duplication is a defect WITHIN a row and not across the table, and the
    // difference is the whole reason this is per-row: the third column answers
    // "what should I read while working here", so `caching.md` is legitimately
    // on four rows — four areas that each need it — while naming it twice in
    // ONE cell is a paste, says nothing the first mention did not, and is
    // invisible to the set difference below. Folded, for the reason the index
    // check gives.
    const twice = named.filter((n, i) => named.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i);
    assert.deepEqual(twice, [],
      `this pointer row names the same archive file more than once (${twice.join(', ')}): ${row.trim()}`);
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

test('the sweep can recognise every record that exists, and refuses what is not one', () => {
  // A floor over how MANY references a sweep found is a backstop and not a
  // proof, because a narrowed extractor still finds most of them: dropping the
  // `-` from `ARCHIVE_PATH`'s character class stops it matching nine of the
  // twenty-two records — every hyphenated one, `day-states.md` included — and
  // still leaves 57 of the 83 path references behind, which clears any floor
  // low enough to survive ordinary comment churn. That is the most ordinary
  // edit this regex will ever get, and its whole effect is to stop checking
  // nine records while reporting no offenders.
  //
  // So the extractors are probed directly, with inputs BUILT from the records
  // that are on disk. This is the assertion; the floors below are the backstop
  // for a walk that stops reaching files, which no probe can see.
  for (const record of records) {
    assert.deepEqual(
      [...`see docs/decisions/${record} for the reasoning`.matchAll(ARCHIVE_PATH)].map((m) => m[1]),
      [record],
      `ARCHIVE_PATH cannot read ${record} out of a sentence spelling its path, so every reference to that record is going unchecked while the offender list stays empty`);
    assert.equal(backtickedRecord(record), record,
      `a pointer file naming \`${record}\` bare would not be recognised as a reference to it`);
    assert.ok(pointsAtTheArchive(`docs/decisions/${record}`),
      `${record} is not treated as a file that points at the archive, so bare names inside it are not swept`);
  }

  // The bare form's two other readers, pinned the same way.
  assert.deepEqual([...'`awards.md`'.matchAll(BACKTICKED_MD)].map((m) => m[1]), ['awards.md'],
    'BACKTICKED_MD no longer reads a backticked filename, which is every bare reference in every CLAUDE.md');
  assert.ok(pointsAtTheArchive('CLAUDE.md') && pointsAtTheArchive('shared/public/CLAUDE.md'),
    'a CLAUDE.md is no longer bare-swept, and those files carry the reference lists this sweep added over the two tables');
  assert.ok(!pointsAtTheArchive('shared/src/stats.js') && !pointsAtTheArchive('README.md'),
    'the bare form has widened past the two kinds of pointer file, which is what makes it noisy rather than useful');

  // The wrapped form, probed through `referencesIn` — the function the sweep
  // itself calls — rather than through its two regexes, because what has to
  // hold is that a two-line reference reaches the offender list, and a regex
  // being right does not make its caller use it. Built from the records on
  // disk for the reason the loop above is, and in the two shapes this repo
  // wraps in: a bare path inside a sentence, and a backticked one whose
  // closing backtick went to the second line.
  for (const record of records) {
    for (const [opening, continuation] of [
      [' * empty sections (see "Do not seed default categories", docs/decisions/', ` * ${record}). Each carries its own`],
      [' * The device\'s calendar day and never a named zone — `docs/decisions/', ` * ${record}\`: \`resolveTimeZone\` asks`],
      ['read the long form in docs/decisions/', `${record} before re-opening it`],
    ]) {
      assert.deepEqual(
        referencesIn('shared/src/example.js', `${opening}\n${continuation}`)
          .map((r) => `${r.where} ${r.name} ${r.form} ${r.wrapped}`),
        [`shared/src/example.js:2 ${record} path true`],
        `a path to ${record} broken across two lines at the archive's slash is not read, so rewrapping a comment silently stops that reference being checked`);
    }
  }

  // And the shapes that must NOT read as one, which is what keeps the signal
  // from being "any line mentioning the directory". The first is the sentence
  // the root CLAUDE.md opens with, naming the DIRECTORY: it closes its
  // backtick, so the line does not end on the slash. The rest are a
  // continuation that is prose rather than the rest of a path.
  for (const [why, text] of [
    ['the directory named in backticks, wrapped after it', 'the reasoning is in `docs/decisions/`\nawards.md is not what this line means'],
    ['a continuation that does not resume a filename', 'everything is written down in docs/decisions/\n * and is read before re-opening a decision'],
    ['a placeholder rather than a record', 'to add one, write docs/decisions/\n * <topic>.md and give it a row'],
    ['a filename that is not first on the line', 'see docs/decisions/\n * the record awards.md for this'],
  ]) {
    assert.deepEqual(referencesIn('shared/src/example.js', text), [],
      `the wrapped form reads a reference out of ${why}, which is honest prose — a guard that fails on that gets deleted`);
  }

  // And what must NOT read as a record. The first two are the prose this guard
  // is likeliest to be written about — a sentence in a pointer file explaining
  // how to add a record — and both were failures before the shape check.
  for (const notAName of ['<topic>.md', '*.md', '.md', 'docs/decisions/awards.md', 'CLAUDE.md', 'traps.md']) {
    assert.equal(backtickedRecord(notAName), null,
      `\`${notAName}\` is read as a bare record reference, and it is not one: honest prose in a pointer file would fail this guard`);
  }
});

test('a directory the walk cannot read is named, and does not take the suite down', (t) => {
  // The walk is the sweep's denominator, and `readdirSync` throwing inside it
  // used to escape as a CRASH — the suite reporting a stack from node:fs
  // instead of a check, which is the failure mode this whole file argues
  // against one directory over. Nobody could construct one without `sudo`,
  // which is why it was left; `chmod 000` on a directory this process owns is
  // the construction, and it needs no privilege at all.
  //
  // Built in the system temp directory rather than under the repo on purpose.
  // A `chmod 000` directory left behind inside a checkout breaks every later
  // run in it AND in any sibling worktree — this test would be the thing that
  // makes the guard it is defending unrunnable — and `sweptFiles` takes the
  // directory to walk, so nothing is lost by walking one somewhere else.
  const dir = mkdtempSync(join(tmpdir(), 'habiterall-archive-'));
  const locked = join(dir, 'locked');
  try {
    mkdirSync(join(dir, 'readable'));
    writeFileSync(join(dir, 'readable', 'seen.md'), 'x\n');
    mkdirSync(locked);
    writeFileSync(join(locked, 'unseen.md'), 'x\n');
    chmodSync(locked, 0o000);

    // Asked rather than assumed: root reads a 0o000 directory happily, and so
    // does a filesystem with no POSIX permissions, and there the assertions
    // below would pass for having built nothing. CI runs this unprivileged.
    let readableAnyway = true;
    try { readdirSync(locked); } catch { readableAnyway = false; }
    if (readableAnyway) {
      t.skip('this process can read a 0o000 directory — running as root, or on a filesystem without POSIX permissions — so there is no unreadable directory here to have named');
      return;
    }

    const unreadable = [];
    const files = sweptFiles(dir, '', [], unreadable);

    // It walked PAST it: the sibling directory was still read, which is what
    // makes the report able to name every unreadable directory rather than
    // dying at the first.
    assert.deepEqual(files, ['readable/seen.md'],
      'the walk did not carry on past a directory it could not read, so one locked directory still costs the rest of the tree');
    // And the file it could not see is missing from that list, which is the
    // whole reason this cannot be a warning: the inventory is now wrong by one
    // file and says nothing about it.
    // The PATH and the presence of a reason, not WHICH reason: Linux and macOS
    // both answer `EACCES` here, but pinning the code makes a platform that
    // answers `EPERM` fail saying the directory "was not reported by path and
    // reason" — which is the opposite of what happened, and sends the reader
    // at the reporting rather than at the errno.
    assert.equal(unreadable.length, 1, `expected one unreadable directory, got ${unreadable.join(', ')}`);
    assert.match(unreadable[0], /^locked \([A-Z]+\)$/,
      'an unreadable directory was not reported by path and reason, so the sweep would print an inventory it has no denominator for');
  } finally {
    // Before `rmSync`, which cannot recurse into 0o000 either — and after a
    // skip or a failed assertion just the same, or the temp directory is left
    // undeletable for whoever cleans /tmp.
    try { chmodSync(locked, 0o700); } catch { /* never created */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every reference to the archive anywhere in the repo names a file that exists', () => {
  // The two tables are the reachable-BY route and they are ~30 pointers. The
  // rest of the repository points at the archive far more often than that, in
  // prose and in source comments — `shared/src/shutdown.js` sends a reader to
  // `connectivity.md` for the numbers behind the drain, `habiterall-cloud/src/
  // api.js` to `caching.md` for the lock order — and a record renamed or
  // deleted leaves every one of them naming nothing, silently and forever.
  // Nobody re-greps the repo for a filename; they follow the pointer, find
  // nothing, and re-derive the decision.
  //
  // Two forms are read, and they are not equally certain, which is why they
  // are not read from the same files. The archive's directory followed by a
  // filename is a path and is unambiguous wherever it appears, so it is read
  // out of every text file in the repository — this file included, which is
  // how the first draft of this comment failed the test it was describing, by
  // spelling the form with a filename nobody had written a record for. It is
  // read across a line break too, where the break falls on the archive's own
  // slash (`WRAPPED_PREFIX`): that was a stated blind spot rather than one
  // found later, and the class kept arriving — a second wrapped reference
  // landed in `shared/public/ui/detail.js` between the guard being written and
  // this being closed, so rewrapping the one comment that had it would have
  // fixed an instance of something still happening. A bare backticked filename
  // is a reference only by convention, so it is read only where that convention
  // holds — a `CLAUDE.md` or a record (`pointsAtTheArchive`). What is
  // deliberately NOT covered: a bare name in a source comment or in any other
  // markdown, and a path broken anywhere other than at that slash. Both are
  // false-NEGATIVES, which cost this guard some reach; a false positive would
  // cost it its life, since a guard that fails on honest prose gets deleted.
  const unreadable = [];
  const files = sweptFiles(root, '', [], unreadable);

  // Asserted BEFORE the inventory is printed, and before every floor below it.
  // The sweep's whole value is its denominator, so a walk that could not read
  // part of the tree must not report a clean inventory — printing one and
  // failing afterwards is a guard telling a reader the count it just proved it
  // could not stand behind. Named here rather than left to a floor, which
  // would either not fire at all or blame the recursion.
  assert.deepEqual(unreadable, [],
    'the sweep could not read these directories, so it walked only part of the tree and every count below is drawn from a denominator it cannot state: '
    + unreadable.join(', '));

  const refs = [];
  for (const path of files) {
    const buf = readFileSync(join(root, path));
    // A NUL byte is the test for binary rather than an extension allowlist,
    // which is a list that goes stale the first time a file type is added.
    if (buf.includes(0)) continue;
    refs.push(...referencesIn(path, buf.toString('utf8')));
  }

  // The denominator, and it is the whole game: an extraction that has stopped
  // matching reports an empty offender list and passes, which is the shape
  // this guard exists to prevent one file over. So the inventory is printed
  // and then floored four ways, each for a different way of finding less.
  const byFile = new Map();
  for (const r of refs) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
  const byForm = (form) => refs.filter((r) => r.form === form).length;
  console.log(`      archive references swept: ${refs.length} in ${byFile.size} files `
    + `(${new Set(refs.map((r) => r.name.toLowerCase())).size} distinct files named), `
    + `out of ${files.length} files read — ${byForm('path')} written as a path, ${byForm('bare')} as a bare filename, `
    + `${[...byFile.keys()].filter((f) => !f.endsWith('.md')).length} of the referring files not markdown`);
  console.log('      ' + [...byFile].sort().map(([f, n]) => `${f} (${n})`).join(', '));

  // The wrapped form is printed by NAME rather than counted, and that is its
  // false-positive audit: it is the one extractor here that reads a line for
  // something another line said, so what it decided has to be checkable at a
  // glance. Two lines in this repo end on the archive's slash, and both are a
  // real reference; a third appearing here that is not one is how the shape
  // being "not innocent" stops being true. Not floored — see `referencesIn`.
  const wrapped = refs.filter((r) => r.wrapped);
  console.log(`      of those, ${wrapped.length} written as a path BROKEN across two lines `
    + `(not asserted on): ${wrapped.map((r) => `${r.where} -> ${r.name}`).join(', ') || 'none'}`);

  // The walk reaching the tree at all. This one can be pinned near its real
  // value because it only ever grows: a skip list that eats a directory, or a
  // recursion that stops at the root, lands far below it.
  assert.ok(files.length >= 300,
    `the sweep read ${files.length} files, far fewer than the ~400 this repo has — a directory is being skipped, or the walk is not recursing`);

  // How many DISTINCT archive files the path form resolved, and this is the
  // sharp one. A reference count drifts with every comment somebody edits, so
  // its floor has to sit far below the real figure; the number of records the
  // sweep can still SEE does not drift that way — 23 of the 23 files in the
  // archive are named by a path somewhere, and losing one means a record has
  // stopped being path-checked at all. It is what a narrowed character class
  // shows up as: nine records vanish from this count while every reference
  // count above stays comfortably over its floor.
  const pathNames = new Set(refs.filter((r) => r.form === 'path').map((r) => r.name.toLowerCase()));
  assert.ok(pathNames.size >= 18,
    `the path form resolved only ${pathNames.size} distinct archive files, against 23 when this guard was written — some records are no longer being matched at all, and an empty offender list says nothing about them`);

  // Every count below is floored WELL under the inventory above, and on
  // purpose. These numbers move with ordinary work — a deleted comment lowers
  // one — and a guard that fails on that gets deleted itself, while the defect
  // being floored against is an extraction returning nothing or nearly so. The
  // printed inventory is what makes a real decline visible; a floor only has
  // to be too high for a broken regex to clear.
  //
  // Floored per form as well as in total, and the reason is NOT the one the
  // first version of this comment gave. It claimed the split catches a partial
  // break that a total hides; between these two forms it did the opposite,
  // because they overlapped on the backticked path spelling and a break in one
  // inflated the other's count. They are disjoint now (`backtickedRecord`), so
  // the two figures are independent — which is all the split is worth, and it
  // is worth having: each form has files the other never reaches, the bare one
  // holding `shared/CLAUDE.md`'s and `shared/public/CLAUDE.md`'s reference
  // lists, which is most of what this sweep added over the two tables.
  assert.ok(byForm('path') >= 40,
    `only ${byForm('path')} references were read in the docs/decisions/… path form, against 83 when this guard was written — that regex is matching less than it did`);
  assert.ok(byForm('bare') >= 30,
    `only ${byForm('bare')} references were read as a bare backticked filename, against 64 when this guard was written — either the extraction is broken or no CLAUDE.md is being reached`);
  assert.ok(refs.length >= 60,
    `only ${refs.length} archive references were found in the whole repository, against 147 when this guard was written — the extraction is broken rather than the references gone`);

  // And every count above says something about the EXTRACTORS and nothing about
  // which files reached them. Source comments are the half of this sweep the two
  // tables never had, and they are thinly spread — one or two references each
  // across twenty-seven files — so a walk that stops reading one KIND of source
  // file leaves every figure above intact. Measured rather than reasoned: stop
  // reading `.mjs`, `.sql` and `.html` and the path form still resolves all 23
  // records from 69 references, the total is 133, and this is the only floor
  // that fires. It counts FILES rather than references because that is how the
  // loss arrives — spread thin, not concentrated in one place.
  //
  // It is a floor on reach, not on regexes, so it does not fire for every break
  // that happens to lower it: requiring backticks in `ARCHIVE_PATH` leaves it at
  // exactly 18 and it stays silent, which is correct — that break is a narrowed
  // extractor and the probe test above is what refuses it, by name and by record.
  const inSource = [...byFile.keys()].filter((f) => !f.endsWith('.md')).length;
  assert.ok(inSource >= 18,
    `only ${inSource} non-markdown files were found to reference the archive, against 27 when this guard was written — the sweep is no longer reading some kind of source file, and a comment pointing at a deleted record in one is exactly what it would stop seeing`);

  const missing = [];
  const miscased = [];
  for (const { where, name } of refs) {
    const r = resolve(name, archiveByFold);
    if (r.missing) missing.push(`${where} -> ${r.missing}`);
    if (r.miscased) miscased.push(`${where} -> ${r.miscased}`);
  }
  assert.deepEqual(missing, [],
    'these point at a decision record that is not in docs/decisions/, so following one arrives nowhere: '
    + missing.join(', '));
  assert.deepEqual(miscased, [],
    'these spell a record in a case the file does not use, which is a broken link on a case-sensitive checkout: '
    + miscased.join(', '));
});
