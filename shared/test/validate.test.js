import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  parseHabit, parseEntry, entryWrite, answerBody, assertDate, assertNotFuture,
  ValidationError, LIMITS, DEFAULT_COLOR, parseIcon, parseCategory,
  foldCategoryName,
} = await import('../src/validate.js');
const { isCompleted } = await import('../src/stats.js');

const SENTINELS = { UNSET: 0, YES: 2, SKIP: 3 };
const boolHabit = { type: 'boolean' };
const numHabit = { type: 'numerical' };

/* ---------- habits ---------- */

test('a minimal habit is filled in with defaults', () => {
  const h = parseHabit({ name: 'Read' });
  assert.equal(h.name, 'Read');
  assert.equal(h.type, 'boolean');
  assert.equal(h.target_type, 'at_least');
  assert.equal(h.freq_numerator, 1);
  assert.equal(h.freq_denominator, 1);
  assert.equal(h.color, DEFAULT_COLOR);
  assert.equal(h.archived, false);
  // 'default' means "follow the account", which is the only value that changes
  // nothing — an override has to be asked for.
  assert.equal(h.at_most_unlogged, 'default');
});

test('the unlogged-day override is clamped to the three it may be', () => {
  // A habit PUT REPLACES, so this field is written on every save from every
  // client. Anything unrecognised has to land on 'default' rather than on
  // `success`, or a typo hands a limit a record it has not earned.
  assert.equal(parseHabit({ name: 'x', at_most_unlogged: 'success' }).at_most_unlogged,
    'success');
  assert.equal(parseHabit({ name: 'x', at_most_unlogged: 'miss' }).at_most_unlogged, 'miss');
  for (const junk of ['SUCCESS', 'yes', '', null, 1, {}, ['success']]) {
    assert.equal(
      parseHabit({ name: 'x', at_most_unlogged: junk }).at_most_unlogged, 'default',
      `${JSON.stringify(junk)} was not clamped`
    );
  }
});

test('name is required and trimmed', () => {
  assert.throws(() => parseHabit({ name: '   ' }), ValidationError);
  assert.throws(() => parseHabit({}), ValidationError);
  assert.equal(parseHabit({ name: '  Run  ' }).name, 'Run');
});

test('over-long text is rejected or clamped, consistently', () => {
  // The name is load-bearing, so an over-long one is an error...
  assert.throws(() => parseHabit({ name: 'x'.repeat(LIMITS.name + 1) }), ValidationError);
  // ...while free text is simply clamped rather than losing the whole request.
  const h = parseHabit({
    name: 'ok',
    description: 'd'.repeat(LIMITS.description + 50),
    unit: 'u'.repeat(LIMITS.unit + 50),
  });
  assert.equal(h.description.length, LIMITS.description);
  assert.equal(h.unit.length, LIMITS.unit);
});

test('frequency must be sane integers', () => {
  assert.throws(() => parseHabit({ name: 'x', freq_numerator: 0 }), ValidationError);
  assert.throws(() => parseHabit({ name: 'x', freq_numerator: 2.5 }), ValidationError);
  assert.throws(() => parseHabit({ name: 'x', freq_numerator: 8, freq_denominator: 7 }),
    ValidationError, 'numerator may not exceed denominator');
  assert.throws(() => parseHabit({ name: 'x', freq_denominator: LIMITS.freqDenominator + 1 }),
    ValidationError, 'a period longer than a year is not a habit');

  const ok = parseHabit({ name: 'x', freq_numerator: 3, freq_denominator: 7 });
  assert.equal(ok.freq_numerator, 3);
  assert.equal(ok.freq_denominator, 7);
});

test('the frequency cap is what bounds the score-saturation bug', () => {
  // A 1x/365d habit was the input that made a single completion report 100%
  // strength. The cap keeps the denominator to a year at most.
  assert.doesNotThrow(() => parseHabit({ name: 'x', freq_denominator: 365 }));
  assert.throws(() => parseHabit({ name: 'x', freq_denominator: 3650 }), ValidationError);
});

test('target_value must be a non-negative finite number', () => {
  assert.throws(() => parseHabit({ name: 'x', target_value: -1 }), ValidationError);
  assert.throws(() => parseHabit({ name: 'x', target_value: NaN }), ValidationError);
  assert.throws(() => parseHabit({ name: 'x', target_value: Infinity }), ValidationError);
  assert.equal(parseHabit({ name: 'x', target_value: 0 }).target_value, 0);
});

test('unknown enum values fall back rather than erroring', () => {
  const h = parseHabit({ name: 'x', type: 'telepathic', target_type: 'roughly' });
  assert.equal(h.type, 'boolean');
  assert.equal(h.target_type, 'at_least');
});

test('colour must be a 6-digit hex, else the default', () => {
  assert.equal(parseHabit({ name: 'x', color: '#ff8800' }).color, '#ff8800');
  assert.equal(parseHabit({ name: 'x', color: 'red' }).color, DEFAULT_COLOR);
  assert.equal(
    parseHabit({ name: 'x', color: '#fff" onload="alert(1)' }).color, DEFAULT_COLOR,
    'an injection attempt must not survive into the DOM'
  );
});

test('errors carry a 400 status for the API layer', () => {
  try {
    parseHabit({});
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 400);
    assert.equal(e.name, 'ValidationError');
  }
});

/* ---------- icon ---------- */

test('a ZWJ sequence is one grapheme and comes back whole', () => {
  // The whole reason a segmenter is used rather than [...value][0] or a
  // .slice: U+200D ZERO WIDTH JOINER is category Cf, and a naive cut through
  // the code units breaks the sequence into orphaned emoji.
  assert.equal(parseIcon('\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}'),
    '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}');
});

test('only the first grapheme survives, and trailing text is dropped', () => {
  assert.equal(parseIcon('\u{1F9D8} extra words here'), '\u{1F9D8}');
});

test('any grapheme is accepted, not only pictographic ones', () => {
  assert.equal(parseIcon('7'), '7');
  assert.equal(parseIcon('運'), '運');
});

test('newlines are gone, either as JS whitespace or as their own grapheme', () => {
  assert.equal(parseIcon('a\nb'), 'a');
  assert.equal(parseIcon('a\r\nb'), 'a');
});

test('a bidi override is stripped, so it cannot reorder the name beside it', () => {
  assert.equal(parseIcon('\u202eevil'), 'e');
});

test('a leading control character is stripped rather than becoming the icon', () => {
  // 'a\nb' above is not a good witness for the \p{Cc} strip: \n is JS
  // "whitespace" so .trim() removes it regardless, and the segmenter isolates
  // any control character into its own grapheme cluster anyway, so taking
  // only the first grapheme already discards a NON-leading one whether or not
  // it was pre-stripped. BEL (U+0007) is outside .trim()'s whitespace set and
  // sits first, so it is the one case where skipping the \p{Cc} strip changes
  // the answer: without it, the control character itself becomes "the icon".
  assert.equal(parseIcon('\u0007'), '', 'a lone control character is no icon at all');
  assert.equal(parseIcon('\u0007\u{1F9D8}'), '\u{1F9D8}',
    'the control character must not outrank the emoji after it');
});

test('a grapheme over the length cap is dropped, never sliced', () => {
  // One grapheme (a base letter plus 200 combining marks) that is still over
  // LIMITS.icon in UTF-16 units. Slicing it would corrupt the cluster, which
  // is exactly what the segmenter exists to prevent — so the field is
  // dropped to '' instead.
  const zalgo = 'e' + '́'.repeat(200);
  assert.ok(zalgo.length > LIMITS.icon);
  assert.equal(parseIcon(zalgo), '');
});

test('an absent icon is the empty string', () => {
  assert.equal(parseHabit({ name: 'x' }).icon, '');
});

test('a partial write clears a previously-set icon', () => {
  // parseHabit REPLACES: a body that names an icon gets it, and a body that
  // omits the field clears it, because PUT /habits/:id runs the whole body
  // through this function with no notion of "leave it".
  assert.equal(parseHabit({ name: 'x', icon: '\u{1F9D8}' }).icon, '\u{1F9D8}');
  assert.equal(parseHabit({ name: 'x' }).icon, '', 'an omitted icon must not survive a replace');
});

/* ---------- category_id on a habit ---------- */

test('an absent category_id is null', () => {
  assert.equal(parseHabit({ name: 'x' }).category_id, null);
});

test('anything not a positive safe integer is null, never coerced', () => {
  for (const junk of ['3', 3.5, 0, -1, true, '__proto__']) {
    assert.equal(
      parseHabit({ name: 'x', category_id: junk }).category_id, null,
      `category_id: ${JSON.stringify(junk)} must give null, not be coerced`,
    );
  }
});

test('a present positive integer id survives as itself', () => {
  assert.equal(parseHabit({ name: 'x', category_id: 7 }).category_id, 7);
});

/* ---------- categories ---------- */

test('a category name is required', () => {
  assert.throws(() => parseCategory({}), ValidationError);
  assert.throws(() => parseCategory({ name: '' }), ValidationError);
  assert.throws(() => parseCategory({ name: '   ' }), ValidationError);
});

test('an over-long category name is capped at LIMITS.name', () => {
  const cat = parseCategory({ name: 'x'.repeat(200) });
  assert.equal(cat.name.length, LIMITS.name);
  assert.equal(cat.name, 'x'.repeat(100));
});

test('a category colour must be a 6-digit hex, else the default', () => {
  assert.equal(parseCategory({ name: 'Health', color: 'blue' }).color, DEFAULT_COLOR);
  assert.equal(parseCategory({ name: 'Health', color: '#00ff88' }).color, '#00ff88');
});

test('foldCategoryName folds Unicode case, not only ASCII', () => {
  // SQLite's NOCASE folds ASCII only; Postgres's lower() is Unicode-aware.
  // This is the one rule both editions ask instead, so 'Élan' and 'élan' are
  // the same category everywhere.
  // Both sides asserted against a LITERAL, not only against each other: a
  // `foldCategoryName` that returned a constant '' would satisfy an
  // equality between its own two answers and nothing else.
  assert.equal(foldCategoryName(' Élan '), 'élan');
  assert.equal(foldCategoryName('élan'), 'élan');
  assert.equal(foldCategoryName(' Élan '), foldCategoryName('élan'));
});

test('foldCategoryName folds with the DOTTED i, never a host locale\'s own', () => {
  // Plain toLowerCase() (no locale argument) always answers the dotted 'i' —
  // a Turkish- or Azeri-locale HOST would instead fold 'Ideas' to a dotless
  // 'ıdeas' under toLocaleLowerCase(), which is exactly the host-tailoring
  // this function must not do: the same account would fold names differently
  // depending on which server happened to answer, and would disagree with
  // Postgres's locale-independent lower() and SQLite's NOCASE besides.
  assert.equal(foldCategoryName('Ideas'), 'ideas');
});

test('foldCategoryName calls .toLowerCase() in its own SOURCE, never toLocaleLowerCase (source guard)', () => {
  // A companion to the test above, not a replacement for it — and the reason
  // it has to exist at all. `'Ideas'.toLocaleLowerCase()` answers 'ideas' on
  // this host's (and CI's) default ICU locale exactly the way `.toLowerCase()`
  // does — `LC_ALL` cannot move a process's already-started default locale —
  // so the behavioural test above passed with `toLocaleLowerCase()` restored,
  // silently proving nothing, while its own comment kept describing a
  // divergence this host is structurally unable to produce. Only a host whose
  // DEFAULT locale is Turkish or Azeri folds 'Ideas' to a dotless 'ı', and
  // nothing here can spin one up to demonstrate it behaviourally. Reading
  // which method the source calls is what is left: a guard on WHICH FUNCTION
  // RUNS, not on what it returns, so it catches exactly the regression the
  // behavioural test cannot — which is also why that test stays rather than
  // being deleted as redundant.
  const src = readFileSync(new URL('../src/validate.js', import.meta.url), 'utf8');
  const fn = /export function foldCategoryName\([^)]*\)\s*\{[^}]*\}/.exec(src);
  assert.ok(fn, "foldCategoryName's declaration was not found — update this guard's regex");
  assert.match(fn[0], /\.toLowerCase\(/,
    'foldCategoryName must fold with .toLowerCase(), not a locale-aware method');
  assert.doesNotMatch(fn[0], /toLocaleLowerCase/,
    'foldCategoryName must not call toLocaleLowerCase — it folds differently per host locale');
});

test("the browser's third copy of the fold (habit-dialog.js's useOrCreateCategory) " +
  'matches foldCategoryName, method for method', () => {
  // `shared/src` is not served to the browser (shared/CLAUDE.md), so
  // `useOrCreateCategory` cannot import `foldCategoryName` and carries its own
  // copy instead — a THIRD one, after this file's rule and the two server
  // routes'. The repo's own answer for a shared rule the browser cannot
  // import is two declarations PLUS a test — `CHANNELS` has
  // `notify.test.js`, `SETTING_VALUES` has `settings.test.js`, the entry
  // sentinels have `toggle.test.js` reading the declaration out of source —
  // and this is that test for the fold. It matters here specifically because
  // the two copies had ALREADY drifted once before round 1 with nothing
  // catching it: the browser's held `toLocaleLowerCase()` and no `.trim()`.
  const dialogSrc = readFileSync(
    new URL('../public/ui/habit-dialog.js', import.meta.url), 'utf8');
  const fnStart = dialogSrc.indexOf('async function useOrCreateCategory');
  assert.ok(fnStart !== -1,
    "useOrCreateCategory not found in habit-dialog.js — update this guard's anchor");
  const fnEnd = dialogSrc.indexOf('\n}\n', fnStart);
  const body = dialogSrc.slice(fnStart, fnEnd);

  const validateSrc = readFileSync(new URL('../src/validate.js', import.meta.url), 'utf8');
  const foldFn = /export function foldCategoryName\([^)]*\)\s*\{([^}]*)\}/.exec(validateSrc);
  assert.ok(foldFn, "foldCategoryName's declaration was not found");

  // Both sides must chain the exact same two calls, TRIM then LOWERCASE — not
  // merely mention "trim" and "lowercase" somewhere each, which a chain-blind
  // check could not tell from `.toLowerCase().trim()` silently reordering the
  // operation on one side only.
  const chain = /\.trim\(\)\.toLowerCase\(\)/;
  assert.match(foldFn[1], chain,
    'foldCategoryName no longer chains .trim().toLowerCase() — update this guard to match, ' +
    'and check useOrCreateCategory still agrees with whatever it does instead');
  const dialogChains = [...body.matchAll(new RegExp(chain.source, 'g'))];
  // Two call sites: the create attempt's own fold, and the case-insensitive
  // lookup in the 409 fallback — both have to use it, or one path folds and
  // the other does not.
  assert.ok(dialogChains.length >= 2,
    "habit-dialog.js's useOrCreateCategory calls .trim().toLowerCase() "
    + `${dialogChains.length} time(s), expected at least 2`);
  assert.doesNotMatch(body, /toLocaleLowerCase/,
    "the browser's copy must not fold with a locale-aware method");
});

/* ---------- entries ---------- */

test('a boolean habit accepts only its sentinels', () => {
  assert.deepEqual(parseEntry(boolHabit, { value: 2 }, SENTINELS),
    { value: 2, status: '', notes: '' });
  assert.deepEqual(parseEntry(boolHabit, { value: 0 }, SENTINELS),
    { value: 0, status: '', notes: '' });
  assert.throws(() => parseEntry(boolHabit, { value: 42 }, SENTINELS), ValidationError);
});

test('a numerical habit accepts any non-negative amount', () => {
  assert.equal(parseEntry(numHabit, { value: 7.5 }, SENTINELS).value, 7.5);
  assert.equal(parseEntry(numHabit, { value: 0 }, SENTINELS).value, 0);
  assert.throws(() => parseEntry(numHabit, { value: -1 }, SENTINELS), ValidationError);
});

test('a numerical 3 is an amount, not a skip', () => {
  // Regression: skips were once stored in-band as the value 3, so "3
  // cigarettes" on an at-most habit was silently reclassified as a skip.
  const e = parseEntry(numHabit, { value: 3 }, SENTINELS);
  assert.equal(e.value, 3);
  assert.equal(e.status, '', 'must NOT be treated as a skip');
});

test('a boolean 3 IS the skip sentinel', () => {
  const e = parseEntry(boolHabit, { value: 3 }, SENTINELS);
  assert.equal(e.status, 'skip');
  assert.equal(e.value, 0, 'a skip never carries a value');
});

test('an explicit status wins for either habit type', () => {
  for (const h of [boolHabit, numHabit]) {
    const e = parseEntry(h, { status: 'skip' }, SENTINELS);
    assert.equal(e.status, 'skip');
    assert.equal(e.value, 0);
  }
});

test('notes are clamped and always present', () => {
  assert.equal(parseEntry(numHabit, { value: 1 }, SENTINELS).notes, '');
  const long = parseEntry(numHabit, { value: 1, notes: 'n'.repeat(LIMITS.notes + 50) }, SENTINELS);
  assert.equal(long.notes.length, LIMITS.notes);
});

/* ---------- answerBody: a reminder press, all the way to storage ---------- */

// #221 gave an avoided habit (show_as: 'avoid' + at_most + numerical) Clean /
// Slipped buttons carrying the ordinary `yes` / `no` actions, correctly — but
// `record()` in both editions mapped those actions with the fixed BOOLEAN
// encoding (yes -> YES, no -> UNSET), which is inverted for an avoided habit:
// `valueForState` already says a clean day stores 0 and a slip stores
// `target + 1`. Assert the STORED VALUE and `isCompleted`, never the label —
// `answerText` said "Clean" while the inverted code wrote a slip, so a label
// assertion would have passed against the bug.
function throughAnswer(habit, action, value) {
  const body = answerBody(habit, { action, value });
  const parsed = parseEntry(habit, body, SENTINELS);
  const write = entryWrite(habit, parsed, SENTINELS);
  return {
    value: write.value,
    completed: isCompleted(habit, { value: write.value, status: write.status }),
  };
}

const avoid0 = { type: 'numerical', target_type: 'at_most', target_value: 0, show_as: 'avoid' };
const avoid2 = { type: 'numerical', target_type: 'at_most', target_value: 2, show_as: 'avoid' };
const atLeast8 = { type: 'numerical', target_type: 'at_least', target_value: 8 };

test('avoided habit, target 0: Clean stores 0 and is completed', () => {
  const r = throughAnswer(avoid0, 'yes');
  assert.equal(r.value, 0);
  assert.equal(r.completed, true);
});

test('avoided habit, target 0: Slipped stores target+1 (1) and is not completed', () => {
  const r = throughAnswer(avoid0, 'no');
  assert.equal(r.value, 1);
  assert.equal(r.completed, false);
});

test('avoided habit, target 2: Clean stores 0 and is completed', () => {
  const r = throughAnswer(avoid2, 'yes');
  assert.equal(r.value, 0);
  assert.equal(r.completed, true);
});

test('avoided habit, target 2: Slipped stores target+1 (3), not a hardcoded 1', () => {
  // The row that proves `target + 1` rather than a fixed 1 — without it a
  // hardcoded `1` in valueForState passes the target-0 case above too.
  const r = throughAnswer(avoid2, 'no');
  assert.equal(r.value, 3);
  assert.equal(r.completed, false);
});

test('boolean habit: yes stores YES and is completed', () => {
  const r = throughAnswer(boolHabit, 'yes');
  assert.equal(r.value, 2);
  assert.equal(r.completed, true);
});

test('boolean habit: no stores UNSET and is not completed', () => {
  const r = throughAnswer(boolHabit, 'no');
  assert.equal(r.value, 0);
  assert.equal(r.completed, false);
});

test('a skip is never routed through valueForState, for any habit', () => {
  for (const h of [boolHabit, numHabit, avoid0, avoid2]) {
    const body = answerBody(h, { action: 'skip' });
    assert.deepEqual(body, { status: 'skip' });
    const parsed = parseEntry(h, body, SENTINELS);
    const write = entryWrite(h, parsed, SENTINELS);
    assert.equal(write.value, 0);
    assert.equal(write.status, 'skip');
    assert.equal(isCompleted(h, { value: write.value, status: write.status }), null);
  }
});

test('an amount press carries its own number straight through', () => {
  const r = throughAnswer(atLeast8, 'amount', 5);
  assert.equal(r.value, 5);
  assert.equal(r.completed, false);
});

/* ---------- dates ---------- */

test('dates must be YYYY-MM-DD', () => {
  assert.equal(assertDate('2026-08-12'), '2026-08-12');
  for (const bad of ['12-08-2026', '2026-8-12', 'today', '', null, '2026-08-12T00:00:00Z']) {
    assert.throws(() => assertDate(bad), ValidationError, `should reject ${bad}`);
  }
});

test('future dates are rejected against the caller\'s today', () => {
  assert.equal(assertNotFuture('2026-08-11', '2026-08-12'), '2026-08-11');
  assert.equal(assertNotFuture('2026-08-12', '2026-08-12'), '2026-08-12', 'today is allowed');
  assert.throws(() => assertNotFuture('2026-08-13', '2026-08-12'), ValidationError);
});
