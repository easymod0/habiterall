import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  formatDateLong, formatDateShort, formatStamp, fromISOLocal, iso, monthLabels,
  weekdayLetters, weekdayNames,
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

test('the month labels are indexed by getMonth(), January first', () => {
  const months = monthLabels();
  assert.equal(months.length, 12);

  for (let m = 0; m < 12; m++) {
    const day = new Date(2026, m, 15);      // mid-month, so no rollover
    assert.equal(
      months[day.getMonth()],
      new Intl.DateTimeFormat(undefined, { month: 'short' }).format(day),
      `index ${m} does not name the month getMonth() calls ${m}`);
  }
});

test('a date is formatted from its LOCAL parts, not shifted through UTC', () => {
  // The trap `fromISOLocal` exists for, one layer up: a formatter handed a date
  // built with `new Date('2026-01-01')` shows 31 December for anyone west of
  // Greenwich. Both helpers take a `Date`, and the callers build it with
  // `fromISOLocal`, so this pins the pairing rather than the formatter.
  for (const date of ['2026-01-01', '2026-06-15', '2026-12-31']) {
    const d = fromISOLocal(date);
    assert.equal(iso(d), date, 'round trip');
    const short = formatDateShort(d);
    const long = formatDateLong(d);
    const dayOfMonth = String(d.getDate());
    assert.ok(short.includes(dayOfMonth), `${short} does not contain ${dayOfMonth}`);
    assert.ok(long.includes(dayOfMonth), `${long} does not contain ${dayOfMonth}`);
    assert.ok(short.includes('2026'), short);
  }
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
  for (const letter of weekdayNames('narrow')) {
    assert.equal([...letter].length, 1, `narrow "${letter}" is not one character`);
  }
});

test('a bucket key is written for a human, and an unknown one is not invented', () => {
  // `windowedChart`'s range readout is handed whatever its chart buckets by,
  // and `BUCKETERS` in stats.js makes four shapes.
  assert.equal(formatStamp('2026-08-16'), formatDateShort(fromISOLocal('2026-08-16')));
  assert.match(formatStamp('2026-08'), /2026/);
  assert.ok(!/\d{4}-\d{2}$/.test(formatStamp('2026-08')), 'a month is not left as a key');
  // No Intl form, already readable, and inventing one is how a label lies.
  assert.equal(formatStamp('2026-Q3'), '2026-Q3');
  assert.equal(formatStamp('2026'), '2026');
  assert.equal(formatStamp('whatever'), 'whatever');
});

test('the lists are frozen, because they are handed out by reference', () => {
  // Held for the life of the page, so one caller reversing in place would
  // corrupt every chart in the session.
  assert.ok(Object.isFrozen(monthLabels()));
  assert.ok(Object.isFrozen(weekdayNames('short')));
  assert.throws(() => { monthLabels().reverse(); });
});

test('the formatters are built once, not per call', () => {
  // The grid header asks for a weekday per column on every paint, and
  // `Intl.DateTimeFormat` is not cheap. Identity is the observable part of the
  // memo: a fresh array every call would also mean a fresh formatter.
  assert.equal(weekdayLetters(), weekdayLetters());
  assert.equal(monthLabels(), monthLabels());
});


test('no module hardcodes a weekday or month list any more', () => {
  // The check `weekcheck.mjs` cannot make. It reads its expected captions from
  // this module now, so it is locale-agnostic — and therefore blind to a
  // hardcoded ENGLISH array when the suite itself runs in English, which is
  // every CI run. Reading the source is the only thing that catches a
  // reintroduction, and it is the pattern `toggle.test.js` already uses to pin
  // `values.js` against `toggle.js`'s own declaration.
  //
  // There were five: two in `ui/dashboard.js`, three in `charts.js`, all
  // silently English whatever the browser was set to.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const suspects = [
    ['charts.js', readFileSync(join(root, 'charts.js'), 'utf8')],
    ['ui/dashboard.js', readFileSync(join(root, 'ui', 'dashboard.js'), 'utf8')],
    ['ui/detail.js', readFileSync(join(root, 'ui', 'detail.js'), 'utf8')],
  ];

  // Two adjacent quoted English day or month names is an array; one on its own
  // is prose, a settings option, or a `weekStart` value.
  const DAYS = 'Sun|Mon|Tue|Wed|Thu|Fri|Sat|Su|Mo|Tu|We|Th|Fr|Sa'
    + '|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
  const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
  const pattern = new RegExp(`'(${DAYS}|${MONTHS})'\\s*,\\s*'(${DAYS}|${MONTHS})'`);

  for (const [name, src] of suspects) {
    const hit = pattern.exec(src);
    assert.equal(hit, null,
      `${name} names weekdays or months itself (${hit?.[0]}) — use ui/dates.js`);
  }
});
