import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  parseHabit, parseEntry, entryWrite, answerBody, assertDate, assertNotFuture,
  queryDate, ValidationError, LIMITS, DEFAULT_COLOR, parseIcon, parseCategory,
  foldCategoryName, parseCategoryId,
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

test('parseCategoryId takes an id spelled as text, and refuses one that merely coerces', () => {
  // The spellings a URL segment and a reorder list legitimately arrive in.
  assert.equal(parseCategoryId(7), 7);
  assert.equal(parseCategoryId('7'), 7);

  // The whole point of the `typeof` gate. `Number()` answers 0 for each of the
  // first three and 1 for `true`, so `Number.isInteger(Number(n))` — what both
  // editions' reorder routes asked — said YES to every one of them: `[null]`
  // reached the UPDATE as id 0 and moved nothing while reporting success, and
  // `[true]` moved whichever category is id 1. Asserted as LITERAL `null`
  // rather than as falsy, because 0 is falsy too and is exactly the wrong
  // answer this is about.
  assert.equal(parseCategoryId(null), null);
  assert.equal(parseCategoryId(undefined), null);
  assert.equal(parseCategoryId(''), null);
  assert.equal(parseCategoryId([]), null);
  assert.equal(parseCategoryId(['1']), null);
  assert.equal(parseCategoryId({}), null);
  assert.equal(parseCategoryId(true), null);
  assert.equal(parseCategoryId(false), null);

  // Not an id, in the ways an id can fail to be one.
  assert.equal(parseCategoryId('abc'), null);
  assert.equal(parseCategoryId(1.5), null);
  assert.equal(parseCategoryId('1.5'), null);
  assert.equal(parseCategoryId(0), null);
  assert.equal(parseCategoryId(-3), null);
  assert.equal(parseCategoryId(NaN), null);
  assert.equal(parseCategoryId(Infinity), null);

  // Past 2^53 an id stops round-tripping through a double: this literal and
  // its neighbour are one value in JS and two rows in Postgres. `9007199254740993`
  // is written out rather than computed, so the boundary is pinned rather than
  // restated from the same expression the implementation uses.
  assert.equal(parseCategoryId(9007199254740993), null);
  assert.equal(parseCategoryId('9007199254740993'), null);
  assert.equal(parseCategoryId(9007199254740991), 9007199254740991);
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

test('foldCategoryName folds U+0130 (dotted capital I) to plain i, the way ' +
  'Postgres\'s lower() does and whole-string toLowerCase() does not', () => {
  // Postgres's lower() maps both 'I' (U+0049) and 'İ' (U+0130) to plain 'i'.
  // JS's whole-string toLowerCase() instead maps 'İ' to 'i' followed by a
  // combining dot above (U+0307) — a different string from 'istanbul' — which
  // is the issue's own example of the route accepting a duplicate the index
  // then 500s on. Assert the literal, not only the pairwise equality: a fold
  // returning a constant would satisfy the equality alone.
  assert.equal(foldCategoryName('İstanbul'), 'istanbul');
  assert.equal(foldCategoryName('İstanbul'), foldCategoryName('Istanbul'));
});

test('foldCategoryName folds the DECOMPOSED spelling (plain i + combining ' +
  'dot above, U+0307) to plain i too — the one pair Postgres\'s ICU ' +
  'collation provider collapses that libc does not', () => {
  // Per codepoint, `'İ'.toLowerCase()` already produces exactly this
  // decomposed string — 'i' followed by U+0307 — so this is not a
  // hypothetical input: it is what folding U+0130 one character at a time
  // yields before the combining-dot strip runs. Under Postgres's ICU
  // provider (never libc), lower() on THIS string also collapses to plain
  // 'i', so a fold that left the decomposed form folding to itself would be
  // a real containment break on an ICU database. Built explicitly from
  // 'i' + the U+0307 escape rather than pasted as a literal combining
  // character, so the input is legible in a diff.
  const decomposedIstanbul = 'i' + '\u0307' + 'stanbul';
  assert.equal(foldCategoryName(decomposedIstanbul), 'istanbul');
  assert.equal(foldCategoryName(decomposedIstanbul), foldCategoryName('İstanbul'));
  assert.equal(foldCategoryName(decomposedIstanbul), foldCategoryName('Istanbul'));
});

test('foldCategoryName collapses a RUN of combining dots above following i, ' +
  'not only a single one — the libc break the `+` quantifier exists for', () => {
  // Two spellings a caller could type, each carrying its OWN combining dot
  // above (U+0307) in addition to whatever the per-codepoint fold produces:
  // 'İ' + the caller's dot, and plain 'I' + the caller's dot. Per codepoint,
  // 'İ'.toLowerCase() is already 'i' + U+0307, so folding the FIRST one
  // produces 'i' + U+0307 + U+0307 — two consecutive combining dots — before
  // either strip runs; folding the SECOND produces only 'i' + U+0307 — one
  // dot. `.replace` is non-overlapping, so a bare (non-quantified)
  // `/i\u0307/gu` eats only the FIRST dot of a run and resumes searching
  // past the survivor: it leaves the first spelling as 'i' + U+0307 (still
  // one dot) while folding the second all the way to plain 'i' — two
  // different strings. Postgres's libc `lower()` measurably does NOT keep
  // them apart: `lower()` maps both 'İ' and 'I' to plain 'i', so libc's
  // answer for both spellings is the SAME string ('i' + U+0307, the user's
  // own dot untouched). That was the shape of the bug the `+` quantifier
  // fixes: a bare strip was looser than its own libc backstop for this pair,
  // in a narrower form than the U+0130 special case it replaced. The `+`
  // matches the WHOLE run of dots in one match, so both spellings collapse
  // to plain 'i' together. Built explicitly from 'İ'/'I' + the U+0307 escape
  // + 'stanbul', never a pasted double-dot glyph, so the two combining marks
  // are legible in a diff.
  const dottedCapitalIPlusOwnDot = 'İ' + '\u0307' + 'stanbul';
  const plainIPlusOwnDot = 'I' + '\u0307' + 'stanbul';
  assert.equal(foldCategoryName(dottedCapitalIPlusOwnDot), 'istanbul');
  assert.equal(foldCategoryName(dottedCapitalIPlusOwnDot), foldCategoryName(plainIPlusOwnDot));
});

test("foldCategoryName folds Final_Sigma the way libc's lower() does — " +
  'position independent, never only the whole-string context-sensitive answer', () => {
  // libc's lower() has no Final_Sigma rule: every Sigma folds to the ordinary
  // (non-final) U+03C3 regardless of where it sits in the string. Whole-string
  // toLowerCase() DOES apply Final_Sigma, so 'ΟΔΟΣ'.toLowerCase() ends in the
  // final form U+03C2 instead — a different string from what 'Οδοσ' folds
  // to, and from what libc's lower()-backed index collapses them to.
  // (Postgres's ICU provider is the OPPOSITE of libc here — it HAS
  // Final_Sigma too, which is a separate pair tested below and is not what
  // this test is about.) Spelled with U+03C3 on purpose, so a regression to
  // the final form (U+03C2) fails on the literal and not only on the
  // cross-check below.
  assert.equal(foldCategoryName('ΟΔΟΣ'), 'οδοσ');
  assert.equal(foldCategoryName('ΟΔΟΣ'), foldCategoryName('Οδοσ'));
});

test('foldCategoryName folds BOTH lowercase spellings of sigma — final ' +
  '(U+03C2) and ordinary (σ, U+03C3) — onto one, the ICU break the ' +
  'U+03C2 -> σ clause exists for', () => {
  // Postgres's ICU provider implements Final_Sigma itself, unlike libc:
  // lower('ΟΔΟΣ') under ICU ends U+03C2 (the FINAL form) because the last
  // Sigma sits at the end of the string, so ICU collapses 'ΟΔΟΣ' with a
  // lowercase spelling that ALSO ends U+03C2 — and per-codepoint folding
  // alone (this function's whole strategy, which is what suppresses
  // Final_Sigma for libc) answers a string ending U+03C3 for 'ΟΔΟΣ' and one
  // ending U+03C2 for that lowercase spelling — two different strings, a
  // real containment break on an ICU database. Built with an explicit U+03C2
  // escape rather than the look-alike character pasted in source, where a
  // diff cannot tell it apart from plain σ (U+03C3).
  const odosEndingFinalSigma = '\u03bf\u03b4\u03bf\u03c2';   // 'odos' spelled with Greek letters, ending U+03C2
  assert.equal(foldCategoryName('ΟΔΟΣ'), 'οδοσ');
  assert.equal(foldCategoryName('ΟΔΟΣ'), foldCategoryName(odosEndingFinalSigma));
});

test('foldCategoryName newly collapses exactly two things relative to the ' +
  'OLD whole-string fold, and enumerating the blast radius is what makes ' +
  'that a checked fact rather than a claim (issue #256, review round 3)', () => {
  // `toLowerCase()` is a no-op on a codepoint that is already lowercase,
  // WHEREVER it sits — so the OLD fold (`String(s).trim().toLowerCase()`,
  // spelled out here rather than imported, because the point is to compare
  // `foldCategoryName` against the rule it REPLACED) never merged two
  // already-lowercase spellings differing only in which sigma ends them, and
  // never merged a plain 'i' against 'i' + the caller's own combining dot
  // above (U+0307). Nothing has ever stopped an account holding both, in
  // EITHER edition, and every earlier test in this file only ever drove the
  // other direction: if `lower()` collapses two strings, so does the fold.
  // This is the reverse question.
  const oldFold = (s) => String(s ?? '').trim().toLowerCase();

  // The test's own claim about the fold — it does NOT import anything from
  // `foldCategoryName` to build this table, because the table is what gets
  // checked AGAINST the fold below. Every Greek letter and combining mark is
  // an explicit \uXXXX escape: a reviewer cannot tell U+03C2 (final sigma)
  // from U+03C3 (ordinary sigma) by eye and must not have to.
  const NEWLY_COLLAPSED = [
    {
      rewrite: 'U+03C2 (final sigma) -> U+03C3 (ordinary sigma)',
      apply: (s) => s.replace(/\u03c2/gu, '\u03c3'),
      // 'logos' (a Greek word), spelled two ways, both ALREADY lowercase,
      // differing only in which sigma ends them.
      pair: [
        '\u03bb\u03bf\u03b3\u03bf\u03c3',   // 'logos' ending ordinary sigma, U+03C3
        '\u03bb\u03bf\u03b3\u03bf\u03c2',   // 'logos' ending final sigma, U+03C2
      ],
      folded: '\u03bb\u03bf\u03b3\u03bf\u03c3',
    },
    {
      rewrite: 'i + a RUN of one or more U+0307 (combining dot above) -> i',
      apply: (s) => s.replace(/i\u0307+/gu, 'i'),
      // 'istanbul' with a combining dot above (U+0307) typed directly after
      // a plain i, against the plain spelling with none.
      pair: [
        'i' + '\u0307' + 'stanbul',
        'istanbul',
      ],
      folded: 'istanbul',
    },
  ];

  // ---- assertion 1: each row is genuinely NEWLY collapsed ----
  // The NEW fold gives both members of the pair the same literal `folded`
  // value, and the OLD fold gives them DIFFERENT values — asserted against
  // the literal on both sides, not only against each other, the same
  // discipline every other test in this file already uses: a fold that
  // returned a constant would satisfy a bare equality between its own two
  // answers and nothing else.
  for (const row of NEWLY_COLLAPSED) {
    const [a, b] = row.pair;
    assert.equal(foldCategoryName(a), row.folded,
      `${row.rewrite}: foldCategoryName(pair[0]) must equal the stated literal`);
    assert.equal(foldCategoryName(b), row.folded,
      `${row.rewrite}: foldCategoryName(pair[1]) must equal the stated literal too`);
    assert.notEqual(oldFold(a), oldFold(b),
      `${row.rewrite}: the OLD fold must keep this pair apart, or it was not NEW`);
  }

  // ---- assertion 2: COMPLETENESS — the single most important assertion in
  // this test. Enumerate every string of length <= 3 over the alphabet
  // below (584 strings) and assert, for every one, that
  // `foldCategoryName(s) === NEWLY_COLLAPSED.reduce((acc, r) => r.apply(acc), oldFold(s))`.
  // This is what turns the table above into a FACT about the fold's whole
  // blast radius rather than a prose claim about two examples: it fails if
  // the fold collapses something the table does not list (an undocumented
  // third rewrite), and it fails if a row is quietly DROPPED from the table
  // (the collapse keeps happening but nothing here explains it any more).
  const ALPHABET = ['i', 'I', '\u0130', '\u0307', '\u03c3', '\u03c2', '\u03a3', 'a'];
  const enumerated = [];
  const build = (prefix, depth) => {
    if (depth > 0) enumerated.push(prefix);
    if (depth < 3) {
      for (const ch of ALPHABET) build(prefix + ch, depth + 1);
    }
  };
  build('', 0);
  assert.equal(enumerated.length, 584,
    'the enumerated alphabet no longer produces 584 strings of length <= 3 — ' +
    'recompute before trusting the completeness sweep below');

  for (const s of enumerated) {
    const expected = NEWLY_COLLAPSED.reduce((acc, row) => row.apply(acc), oldFold(s));
    assert.equal(foldCategoryName(s), expected,
      `foldCategoryName(${JSON.stringify(s)}) diverges from oldFold + every ` +
      'listed rewrite — the table no longer explains the whole blast radius');
  }

  // ---- assertion 3: each row is NECESSARY ----
  // Removing just that row from the reduction must break the equation above
  // for at least one enumerated string, so a spurious or redundant row
  // cannot be added to the table without this test noticing.
  for (let i = 0; i < NEWLY_COLLAPSED.length; i++) {
    const withoutRow = NEWLY_COLLAPSED.filter((_, idx) => idx !== i);
    const stillHoldsEverywhere = enumerated.every((s) =>
      foldCategoryName(s) === withoutRow.reduce((acc, row) => row.apply(acc), oldFold(s)));
    assert.ok(!stillHoldsEverywhere,
      `removing row ${i} (${NEWLY_COLLAPSED[i].rewrite}) left the equation ` +
      'holding for every enumerated string — this row does no work and ' +
      'should not be in the table');
  }
});

test('foldCategoryName folds an astral character by CODE POINT, not by ' +
  'UTF-16 unit', () => {
  // U+10400 (DESERET CAPITAL LETTER LONG I) is outside the BMP and encoded as
  // a surrogate pair. A loop indexing by UTF-16 unit would split the pair and
  // fold each half separately, producing neither a valid character nor the
  // correct answer; folding by code point answers its real lowercase pair,
  // U+10428.
  assert.equal(foldCategoryName('𐐀'), '𐐨');
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
  // The closing brace has to be the FUNCTION's own, not the first `}` the
  // regex meets — `[^}]*\}` used to stop at the `for` loop's closing brace,
  // so the captured text never reached `return`. A function-level `}` sits
  // at the start of its own line (no indentation); every inner block's does
  // not, so `\n\}` anchors to the real end of the declaration.
  const fn = /export function foldCategoryName\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, "foldCategoryName's declaration was not found — update this guard's regex");
  assert.match(fn[0], /\.toLowerCase\(/,
    'foldCategoryName must fold with .toLowerCase(), not a locale-aware method');
  assert.doesNotMatch(fn[0], /toLocaleLowerCase/,
    'foldCategoryName must not call toLocaleLowerCase — it folds differently per host locale');
});

test('the browser holds NO copy of the fold — the category picker asks the server ' +
  'and reads its answer (source guard)', () => {
  // This test used to assert the opposite: that `habit-dialog.js`'s own
  // `useOrCreateCategory` chained `.trim().toLowerCase()` exactly as
  // `foldCategoryName` does, on the reasoning that `shared/src` is not served
  // to the browser (shared/CLAUDE.md) so a third hand-written copy was
  // unavoidable. The import is unavoidable; the copy was not. That copy ran in
  // exactly one place — after a 409 from `POST /categories`, resolving the
  // chip's name to the row the server had just refused to duplicate — which
  // means it could only ever run when a server that had ALREADY computed the
  // answer had just replied, and never offline, where the POST is queued and
  // throws `err.queued` instead. The root CLAUDE.md's rule for a hand-copied
  // rule is that a client earns one only if it must work OFFLINE, and this
  // one plainly did not; it had also already drifted once (holding
  // `toLocaleLowerCase()` and no `.trim()`) before anything caught it. The
  // chip now reports the 409 and says to pick the existing category, so the
  // rule lives in `foldCategoryName` and the two editions' routes alone.
  //
  // A source guard, and only half the answer, per the root CLAUDE.md: it
  // cannot see a fold written some other way, and it says nothing about what
  // the chip DOES with the refusal. `categorycheck.mjs`'s "a chip for a
  // category that already exists says so, and not in the error class" is the
  // behavioural half that watches the branch this leaves in place.
  const dialogSrc = readFileSync(
    new URL('../public/ui/habit-dialog.js', import.meta.url), 'utf8');
  assert.doesNotMatch(dialogSrc, /toLowerCase|toLocaleLowerCase/,
    'habit-dialog.js folds a name itself again — that is a third copy of ' +
    'foldCategoryName, and the browser does not earn one: the branch that ' +
    'wanted it is unreachable offline. Let the route answer, and see ' +
    'docs/decisions/categories.md');
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

test('a query-string date that is not a string is REFUSED, never coerced', () => {
  // The one shape `queryDate`'s `typeof` guard is the only thing standing in
  // front of, and it has no coverage at either edition's routes because
  // neither can produce it: a ONE-element array, which `query parser:
  // 'extended'` makes out of `?end[]=2026-08-18` and Express 5's default
  // `simple` parser cannot. `String(['2026-08-18'])` is '2026-08-18', so a
  // version that coerced would pass DATE_RE and then call `.split` on an
  // ARRAY — a TypeError, which every route here turns into a 500 rather than
  // the 400 this is. The class is named for exactly that reason: a TypeError
  // reaching this assertion is the defect, not a different spelling of it.
  assert.throws(() => queryDate(['2026-08-18'], '2026-08-18'), ValidationError);

  // The repeated `?end=a&end=b` both route suites send is the OTHER array —
  // two or more elements, so it coerces with a comma in it and `DATE_RE`
  // refuses it with the guard deleted too. It is here for completeness and
  // labelled so it is not mistaken for this guard's coverage.
  assert.throws(() => queryDate(['2026-08-18', '2026-01-01'], '2026-08-18'),
    ValidationError);

  // Absence is the caller's fallback and is the only value that is not an
  // error. Present-and-empty is present-and-wrong: there is nothing to guess.
  assert.equal(queryDate(undefined, '2026-08-18'), '2026-08-18');
  assert.equal(queryDate('2026-01-01', '2026-08-18'), '2026-01-01');
  assert.throws(() => queryDate('', '2026-08-18'), ValidationError);
  // And a present date still goes through `assertDate`, not just DATE_RE.
  assert.throws(() => queryDate('2026-00-10', '2026-08-18'), ValidationError);
});

test('future dates are rejected against the caller\'s today', () => {
  assert.equal(assertNotFuture('2026-08-11', '2026-08-12'), '2026-08-11');
  assert.equal(assertNotFuture('2026-08-12', '2026-08-12'), '2026-08-12', 'today is allowed');
  assert.throws(() => assertNotFuture('2026-08-13', '2026-08-12'), ValidationError);
});
