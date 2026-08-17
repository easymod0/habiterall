import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  estimateTextWidth, formatDateLong, formatDateShort, formatStamp, fromISOLocal,
  formatDayNumber, formatDayRange, formatMonthShort, formatYear, gutterFor, iso, weekdayLetters,
  weekdayNames,
} = await import('../public/ui/dates.js');

/**
 * The presentation helpers, and the one way they can go wrong quietly.
 *
 * These replaced two hardcoded English arrays — one in `ui/dashboard.js`, one in
 * `charts.js` — with `Intl`, and the arrays were indexed by `getDay()` and
 * `getMonth()`. So the risk the swap introduces is not the WORDS, which are the
 * platform's; it is the INDEX. A reference week starting on the wrong day
 * rotates every weekday caption in the app by one, which is the failure
 * `weekcheck.mjs` exists for and which reads as deliberate rather than broken.
 *
 * Asserted against the same `Date` the callers pass, rather than against
 * literals: the strings depend on the runtime's locale and pinning them here
 * would make this suite say "en-US" when what it means is "the right day".
 */

test('the weekday letters are indexed by getDay(), Sunday first', () => {
  const letters = weekdayLetters();
  assert.equal(letters.length, 7);

  // A month with a known shape: 2026-01-04 is a Sunday.
  for (let i = 0; i < 7; i++) {
    const day = new Date(2026, 0, 4 + i);
    assert.equal(day.getDay(), i, 'the reference week itself must start on Sunday');
    assert.equal(
      letters[day.getDay()],
      new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(day),
      `index ${i} does not name the day getDay() calls ${i}`);
  }
});

test('a month name comes from the date, not from an index', () => {
  // The defect this replaced: twelve names built from 2026 samples and read
  // with `getMonth()`. `getMonth()` is a Gregorian field, so the table is only
  // right where the locale's calendar is Gregorian — and under fa-IR the
  // dashboard's header and the amount dialog named two different months for
  // one day. Asserted against `Intl` given the same date, so it holds in every
  // calendar rather than in en-US.
  const f = new Intl.DateTimeFormat(undefined, { month: 'short' });
  for (const d of [new Date(2026, 0, 28), new Date(2026, 7, 16),
                   new Date(1905, 11, 31), new Date(2031, 5, 1)]) {
    assert.equal(formatMonthShort(d), f.format(d));
  }

  // Two dates in the same Gregorian month can fall in DIFFERENT months of
  // another calendar, which an index by `getMonth()` cannot express at all.
  const persian = new Intl.DateTimeFormat('fa-IR', { month: 'short' });
  assert.notEqual(persian.format(new Date(2026, 0, 5)),
                  persian.format(new Date(2026, 0, 28)),
    'the premise of this test: one Gregorian month spans two Persian ones');
});

test('a year comes from the date, in this calendar', () => {
  // The same rule as `formatMonthShort` and it was missing for a while: the
  // month captions went through `Intl` and the YEAR under them was
  // `String(yy)`, so a chart printed a Persian month over a Gregorian year and
  // its own tooltip disagreed with it by 621 years.
  const f = new Intl.DateTimeFormat(undefined, { year: 'numeric' });
  for (const d of [new Date(2026, 0, 15), new Date(2026, 7, 16), new Date(1999, 11, 31)]) {
    assert.equal(formatYear(d), f.format(d));
  }
  // Not `String(d.getFullYear())`: that is right only where the calendar is
  // Gregorian, which is the assumption being removed.
  const buddhist = new Intl.DateTimeFormat('th-TH', { year: 'numeric' });
  assert.notEqual(buddhist.format(new Date(2026, 7, 16)), '2026',
    'the premise: th-TH does not number years the way getFullYear does');
});

test('a range can be asked for in less room', () => {
  const a = new Date(2025, 11, 28);
  const b = new Date(2026, 0, 4);
  const wordy = formatDayRange(a, b);
  const short = formatDayRange(a, b, 'short');

  // `short` is the all-numeric form, for a label that has to fit a phone.
  // Asserted as "no letters of its own" rather than by length: it is not
  // shorter in every locale (ja-JP and ko-KR write the numeric form wide), and
  // the property that matters is that it stops spending room on a month NAME.
  assert.ok(short.length > 0);
  assert.equal(short, new Intl.DateTimeFormat(undefined,
    { year: 'numeric', month: 'numeric', day: 'numeric' }).formatRange(a, b));
  // NOT `notEqual(short, wordy)`: lt-LT writes both as `2025-12-28 – 2026-01-04`
  // and ja-JP likewise, because their short month form already IS a number.
  // Asking for less room is allowed to change nothing.

  // A one-day range is still one date in either style.
  assert.equal(formatDayRange(a, a, 'short'), new Intl.DateTimeFormat(undefined,
    { year: 'numeric', month: 'numeric', day: 'numeric' }).format(a));

  // An unknown style is the wordy one, not a crash and not a third format.
  assert.equal(formatDayRange(a, b, 'nonsense'), wordy);
});

test('a range is Intl\'s to compose, including what the two ends share', () => {
  const a = new Date(2026, 7, 3);
  const b = new Date(2026, 7, 16);
  const f = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  assert.equal(formatDayRange(a, b), f.formatRange(a, b));
  // One day is one date, not the same date twice with a dash between.
  assert.equal(formatDayRange(a, a), f.format(a));
  // It must still be a range: both ends have to be recoverable from it.
  assert.notEqual(formatDayRange(a, b), formatDayRange(a, new Date(2026, 7, 17)));
});

test('a date is formatted from its LOCAL parts, not shifted through UTC', () => {
  // The trap `fromISOLocal` exists for, one layer up: a formatter handed a date
  // built with `new Date('2026-01-01')` shows 31 December for anyone west of
  // Greenwich. Both helpers take a `Date`, and the callers build it with
  // `fromISOLocal`, so this pins the pairing rather than the formatter.
  for (const date of ['2026-01-01', '2026-06-15', '2026-12-31']) {
    const d = fromISOLocal(date);
    assert.equal(iso(d), date, 'round trip');
    // The formatter's own answer for the same `Date`, which is the only thing
    // that is true everywhere. Two earlier versions asserted the string
    // CONTAINED '2026' and the day number: false in ar-EG and bn-IN, whose
    // digits are not Latin, and false again in fa-IR and th-TH, which do not
    // use this calendar at all — `2026-01-01` is `۱۱ دی ۱۴۰۴` and
    // `1 ม.ค. 2569`. What the helpers owe their callers is the right DATE and
    // a stable set of options, not a particular numeral.
    assert.equal(formatDateShort(d),
      new Intl.DateTimeFormat(undefined,
        { year: 'numeric', month: 'short', day: 'numeric' }).format(d));
    assert.equal(formatDateLong(d),
      new Intl.DateTimeFormat(undefined,
        { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d));
  }

  // And they are actually a function of the date — the check above would hold
  // for a formatter that ignored its argument.
  const days = ['2026-01-01', '2026-01-02', '2026-06-15'].map(fromISOLocal);
  assert.equal(new Set(days.map(formatDateShort)).size, 3);
  assert.equal(new Set(days.map(formatDateLong)).size, 3);

  // The trap `fromISOLocal` exists for, stated as a property rather than a
  // string: a date built by parsing '2026-01-01' as UTC is 31 December for
  // anyone west of Greenwich, so these two must not print the same.
  assert.notEqual(formatDateShort(fromISOLocal('2026-01-01')),
    formatDateShort(fromISOLocal('2025-12-31')));
});

test('a gutter reserves more than the label needs, in any script', () => {
  // The arithmetic two charts size their left gutter with, pinned here rather
  // than only in `weekcheck` — where it can only ever be exercised in whatever
  // locale the runner happens to be in. Reverting `weekdayMonthChart` to a
  // fixed 42px is invisible in English (`Mon` fits) and clips in pt-PT, so a
  // browser assertion alone leaves CI blind to it.
  const FONT = 10.5;
  for (const labels of [
    ['Mon', 'Tue', 'Wed'],                 // en
    ['domingo', 'segunda', 'sábado'],      // pt-PT — clipped a fixed 42px
    ['Jumamosi', 'Jumatatu'],              // sw-KE — the widest measured
    ['月曜日', '日曜日'],                    // ja — square glyphs
    ['أغسطس', 'الخميس'],                    // ar
    ['ᏉᏅᎯ'],                                // chr — was taking the Latin rate
  ]) {
    const gutter = gutterFor(labels, FONT, 42, 8);
    for (const label of labels) {
      assert.ok(gutter >= estimateTextWidth(label, FONT) + 8,
        `"${label}" needs ${estimateTextWidth(label, FONT)}+8, gutter is ${gutter}`);
    }
  }
  // The floor holds for the common case, so nothing narrows where it did not.
  assert.equal(gutterFor(['Mon', 'Tue'], FONT, 42, 8), 42);
  // ...and a long one grows past it rather than clipping.
  assert.ok(gutterFor(['Jumamosi'], FONT, 42, 8) > 42);
  // An empty set falls back to the floor rather than -Infinity.
  assert.equal(gutterFor([], FONT, 58, 8), 58);
});

test('a combining mark is not free, because Chrome advances for it', () => {
  // This asserted the opposite, on the reasoning that a mark sits ON the
  // character before it. Measured with `getComputedTextLength()`: Malayalam
  // `\u0D2C\u0D41` renders 18.0px at font-size 11 against an estimate of 11.0 — the worst
  // under-estimate in the whole corpus, and it came from billing the mark at
  // nothing. It is billed at 0.4em now, which is still well under a base
  // character, so the Indic gutters the old comment worried about stay sane.
  const base = estimateTextWidth('\u0938', 10.5);            // \u0938
  const withMark = estimateTextWidth('\u0938\u0941', 10.5);  // \u0938\u0941
  assert.ok(withMark > base, 'a combining vowel sign must cost something');
  assert.ok(withMark < base * 2, 'but less than a base character');
});

test('every weekday width is indexed the same way, and narrow is one character', () => {
  // `narrow` is what the seven-column grid header and the month grid's rows
  // read, and both depend on it staying one character. Measured across en, de,
  // fr, ru, pl, fi, ja and id when this landed; asserted here for whatever
  // locale the suite runs in.
  for (const style of ['narrow', 'short', 'long']) {
    const names = weekdayNames(style);
    assert.equal(names.length, 7, style);
    for (let i = 0; i < 7; i++) {
      const day = new Date(2026, 0, 4 + i);
      assert.equal(names[day.getDay()],
        new Intl.DateTimeFormat(undefined, { weekday: style }).format(day),
        `${style} index ${i}`);
    }
  }
  assert.deepEqual(weekdayLetters(), weekdayNames('narrow'),
    'the letters ARE the narrow names — one list, not two');

  // NOT "narrow is one character". It is in en, de, fr, ru, pl, fi, ja and id,
  // and it is NOT in fil-PH (`Lin Lun Mar`), ca-ES (`dg. dl.`), vi-VN (`CN T2`)
  // or hu-HU (`Sz`) — so an earlier version of this assertion failed outright
  // on those developers' machines while passing in CI, which is the same
  // English-runtime blindness this file exists to remove.
  //
  // What is actually true, and what the layouts rely on, is that narrow is
  // never WIDER than short. The seven-column grid header is measured rather
  // than assumed: `responsive.mjs` covers it at 360px.
  const narrow = weekdayNames('narrow');
  const short = weekdayNames('short');
  for (let i = 0; i < 7; i++) {
    assert.ok([...narrow[i]].length <= [...short[i]].length,
      `narrow "${narrow[i]}" is wider than short "${short[i]}"`);
  }
});

test('a label width is estimated generously, never meanly', () => {
  // There is no text metric without a DOM and two suites drive charts.js with
  // a fake one, so a chart reserving room for a label has to estimate. Being
  // over costs a few pixels of gutter — bounded by `gutterFor`'s ceiling —
  // while being under costs a clipped word: measured, `domingo` and
  // `Jumamosi` ran off the month grid before this existed.
  //
  // The rates are measured (see the module), so what is asserted here is the
  // ORDERING they have to preserve. Each pair below was a real error in the
  // previous set, and the test named itself after a property it did not check.
  assert.ok(estimateTextWidth('Mon', 10.5) > 0);
  assert.equal(estimateTextWidth('', 10.5), 0);
  assert.ok(estimateTextWidth('Jumamosi', 10.5) > estimateTextWidth('Mon', 10.5));

  // A square CJK glyph against a Latin capital.
  assert.ok(estimateTextWidth('\u6708', 10.5) > estimateTextWidth('M', 10.5));

  // A CAPITAL is not a lowercase letter. Billed identically at 0.65em before,
  // and `W` measures 0.93 — so the commonest narrow weekday label in English
  // was under-reserved by 1.43x, in the locale CI runs in.
  assert.ok(estimateTextWidth('W', 10.5) > estimateTextWidth('w', 10.5));
  assert.ok(estimateTextWidth('MMMM', 10.5) > estimateTextWidth('llll', 10.5));

  // Arabic SHAPES: a letter alone takes its isolated form and is wide, the
  // same letter in a word joins and is narrow. Billing every Arabic character
  // at a full em is what reserved 157px of a 328px card for fa-IR row labels.
  assert.ok(estimateTextWidth('\u0623', 10.5) > estimateTextWidth('a', 10.5),
    'a lone Arabic letter is wide');
  assert.ok(estimateTextWidth('\u0623\u063A\u0633\u0637\u0633', 10.5)
    < 5 * estimateTextWidth('\u0623', 10.5),
    'five joined letters are not five isolated ones');
});

test('a numeral is billed as a numeral, whatever script it is written in', () => {
  // `/[0-9]/` was ASCII-only and sat below the SCRIPT tests, so a Devanagari
  // or Bengali digit was billed at its script's LETTER rate. Measured, the
  // same date in the two numbering systems came out 1.77x apart — which is
  // what shrank ne-NP and as-IN streak labels to a 7.5px font while en-US kept
  // 11.5, and what was mistaken for two pixels of real overflow when the size
  // floor was lowered.
  //
  // A date is mostly digits, so this is asserted on a whole label rather than
  // on one character: it is the shape the charts actually hand it.
  const ASCII = '2026-04-21 \u2013 2026-05-18';
  const DEVA = '\u0968\u0966\u0968\u096C-\u0966\u096A-\u0968\u0967 \u2013 \u0968\u0966\u0968\u096C-\u0966\u096B-\u0967\u096E';
  assert.equal(estimateTextWidth(DEVA, 11.5), estimateTextWidth(ASCII, 11.5),
    'the same date in two numbering systems is the same width');

  // ...and a digit is not a letter of its own script. `\u0968` against `\u0905`.
  assert.ok(estimateTextWidth('\u0968', 11.5) < estimateTextWidth('\u0905', 11.5),
    'a Devanagari digit is billed under a Devanagari letter');

  // But NOT one rate for every digit, which is the other way to be wrong.
  // Measured per glyph against `getComputedTextLength()`, Malayalam digits are
  // 0.849em and Arabic-Indic 0.459em — 1.85x apart — so a single number either
  // clips the wide half or hands the narrow half a gutter half again too big.
  const wide = estimateTextWidth('\u0D66\u0D67\u0D68\u0D69\u0D6A', 11.5);   // Malayalam
  const narrow = estimateTextWidth('\u0660\u0661\u0662\u0663\u0664', 11.5); // Arabic-Indic
  assert.ok(wide > narrow, 'Malayalam digits are wider than Arabic-Indic ones');

  // A script nobody has measured falls to the WIDE rate, not the narrow one:
  // over-reserving costs pixels and under-reserving clips. Sinhala is not in
  // the measured list, so it stands in for the next one added.
  assert.ok(estimateTextWidth('\u0DE6\u0DE7\u0DE8\u0DE9\u0DEA', 11.5) > narrow,
    'an unmeasured numbering system is billed high, not cheaply');
});

test('a day number comes from the date, in this calendar and its digits', () => {
  // `String(d.getDate())` is `monthLabels()` one field over, and the
  // dashboard's own header is where it showed: the range label above the
  // columns was localised and the column captions under it were not, so fa-IR
  // read a Persian range over Gregorian ASCII day numbers — "16 against 25 for
  // the same day", inside one header row.
  const f = new Intl.DateTimeFormat(undefined, { day: 'numeric' });
  for (const d of [new Date(2026, 0, 28), new Date(2026, 7, 16),
                   new Date(1905, 11, 31), new Date(2031, 5, 1)]) {
    assert.equal(formatDayNumber(d), f.format(d));
  }

  // The premise, stated so this cannot quietly become a test about en-US: in a
  // non-Gregorian calendar the day number itself differs from `getDate()`.
  const persian = new Intl.DateTimeFormat('fa-IR', { day: 'numeric' });
  const d = new Date(2026, 7, 16);
  assert.notEqual(persian.format(d), String(d.getDate()),
    'fa-IR numbers this day differently from the Gregorian field');
});

test('a bucket key is written for a human, and an unknown one is not invented', () => {
  // `windowedChart`'s range readout is handed whatever its chart buckets by,
  // and `BUCKETERS` in stats.js makes four shapes.
  assert.equal(formatStamp('2026-08-16'), formatDateShort(fromISOLocal('2026-08-16')));
  // Not "contains 2026": fa-IR and th-TH do not use this calendar, so the year
  // in the output is 1405 or 2569. What must hold is that it stopped being a
  // key and that it still distinguishes one month from another.
  // Not "it stopped looking like a key" — in lt-LT the correct `yMMM` IS
  // `2026-08`, so that would fail on the right answer. What must hold is that
  // it went through the formatter.
  assert.equal(formatStamp('2026-08'),
    new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' })
      .format(new Date(2026, 7, 15)));
  assert.notEqual(formatStamp('2026-08'), formatStamp('2026-09'));
  assert.notEqual(formatStamp('2026-08'), formatStamp('2027-08'));
  // Pinned against a KNOWN date rather than against itself. Every assertion
  // above passes with `slice(5, 7) - 1` written as `slice(5, 7)`, which reads
  // every bucket as the month after it and December as the following January —
  // mutation-tested against `npm test`, `typecheck` and all 27 browser suites,
  // none of which noticed.
  assert.equal(formatStamp('2026-08'),
    new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' })
      .format(new Date(2026, 7, 15)));
  assert.equal(formatStamp('2026-12'),
    new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' })
      .format(new Date(2026, 11, 15)));
  // No Intl form, already readable, and inventing one is how a label lies.
  assert.equal(formatStamp('2026-Q3'), '2026-Q3');
  assert.equal(formatStamp('2026'), '2026');
  assert.equal(formatStamp('whatever'), 'whatever');
});

test('the lists are frozen, because they are handed out by reference', () => {
  // Held for the life of the page, so one caller reversing in place would
  // corrupt every chart in the session.
  assert.ok(Object.isFrozen(weekdayNames('short')));
  assert.ok(Object.isFrozen(weekdayNames('narrow')));
  assert.throws(() => { weekdayNames('short').reverse(); });
});

test('the formatters are built once, not per call', () => {
  // The grid header asks for a weekday per column on every paint, and
  // `Intl.DateTimeFormat` is not cheap. Identity is the observable part of the
  // memo: a fresh array every call would also mean a fresh formatter.
  assert.equal(weekdayLetters(), weekdayLetters());
  assert.equal(weekdayNames('long'), weekdayNames('long'));
});


test('no module hardcodes a weekday or month list any more', () => {
  // The check `weekcheck.mjs` cannot make. It reads its expected captions from
  // this module now, so it is locale-agnostic — and therefore blind to a
  // hardcoded array when the suite itself runs in the same locale, which is
  // every CI run. Reading the source is the only thing that catches a
  // reintroduction; it is the pattern `toggle.test.js` uses to pin `values.js`.
  //
  // Shaped by LENGTH, not by English words. A first version looked for two
  // adjacent quoted English day names and a review walked straight past it:
  // `['S','M','T','W','T','F','S']` — the exact array this change deleted from
  // `charts.js` — has no such pair, and neither would a translated one. Seven
  // or twelve short quoted strings in an array literal is what a weekday or
  // month list IS, whatever language it is in.
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const files = readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => join(dir, String(f)))
    .filter((f) => statSync(f).isFile() && !f.endsWith(join('ui', 'dates.js')));
  assert.ok(files.length > 10, `only found ${files.length} modules to scan`);

  // 7 or 12 elements, each a quoted string short enough to be a label.
  //
  // A quote CLASS, not a backreference. `\1` was the first version and it
  // silently failed on the twelve-item branch: the group is written twice in
  // the pattern, so the second copy is group 3 and `\1` pointed at the wrong
  // one — the month array went straight through. Matching `'x"` too is a
  // non-issue here; this is a detector, not a parser.
  const item = String.raw`['"][^'"\n]{1,12}['"]`;
  const list = new RegExp(
    String.raw`\[\s*(?:${item}\s*,\s*){6}${item}\s*,?\s*\]`      // seven
    + '|'
    + String.raw`\[\s*(?:${item}\s*,\s*){11}${item}\s*,?\s*\]`, // twelve
    's');

  // Comments stripped first, which fixes a miss and a false positive at once:
  // a `// sunday` between two elements defeated the separator, and a sentence
  // like "two ambiguous 'Jan', 'Jan' columns" in prose matched when it should
  // not. Crude is fine — this is a detector, not a parser.
  const code = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  for (const file of files) {
    const hit = list.exec(code(readFileSync(file, 'utf8')));
    assert.equal(hit, null,
      `${file.slice(dir.length + 1)} has a 7- or 12-item label list `
      + `(${hit?.[0].replace(/\s+/g, ' ').slice(0, 60)}) — use ui/dates.js. `
      + 'If it is not a weekday or month list, it is the wrong shape here.');
  }
});

test('no module writes a Gregorian date field out as TEXT', () => {
  // The same detector one field over, and the reason it is needed is that the
  // list version could not see the last two instances of this defect.
  // `String(d.getDate())` in the dashboard's grid header is not a list; it is a
  // Gregorian FIELD printed as a label, which is right in en-US and in every
  // locale using ASCII digits and a Gregorian calendar — so a browser suite,
  // a fake-DOM suite and the whole unit run all pass while fa-IR reads
  // `\u06f1\u06f9 \u062a\u0627 \u06f2\u06f5 \u0645\u0631\u062f\u0627\u062f \u06f1\u066a\u0665` over columns numbered 10 11 12.
  //
  // Only the TEXT sinks, which is what makes this narrow enough to be useful:
  // `getDate()` is a perfectly good way to walk a calendar, and `charts.js`
  // and `ui/calendar.js` both do arithmetic with it. What is banned is handing
  // one to a USER: `textContent`, `String(...)` and a template hole.
  //
  // The one legitimate template hole is `iso()` — a storage key MUST be
  // Gregorian and ASCII, which is the opposite rule — and it lives in
  // `ui/dates.js`, which this scan excludes. `charts.js` had a byte-identical
  // copy of it; that copy is gone rather than exempted, because an exemption
  // here would also excuse the next hand-built date string.
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const files = readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => join(dir, String(f)))
    .filter((f) => statSync(f).isFile() && !f.endsWith(join('ui', 'dates.js')));
  assert.ok(files.length > 10, `only found ${files.length} modules to scan`);

  const field = String.raw`\.get(?:Date|Month|FullYear)\(\)`;
  const sinks = new RegExp(
    String.raw`String\(\s*[A-Za-z_$][\w$.]*${field}`          // String(d.getDate())
    + '|'
    + String.raw`textContent\s*=\s*[^;\n]*${field}`           // el.textContent = d.getMonth()
    + '|'
    + String.raw`\$\{[^}]*${field}[^}]*\}`,                   // `${d.getFullYear()}`
    's');

  const code = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  for (const file of files) {
    const hit = sinks.exec(code(readFileSync(file, 'utf8')));
    assert.equal(hit, null,
      `${file.slice(dir.length + 1)} writes a Gregorian date field out as text `
      + `(${hit?.[0].replace(/\s+/g, ' ').slice(0, 60)}) — `
      + 'use formatDayNumber / formatMonthShort / formatYear from ui/dates.js');
  }
});
