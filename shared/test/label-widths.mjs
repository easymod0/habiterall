/**
 * Measures `estimateTextWidth` against REAL rendered width, in a real
 * browser, for every label `charts.js` draws, across the locales
 * `locales.mjs` sweeps and the font sizes the charts actually feed it.
 *
 * This is #132's Step 1: the instrument the rest of that issue is judged
 * against, not a suite of its own. It asserts nothing and is not wired into
 * `npm test`, `run.mjs`'s auto-discovery (it lives outside `browser/`, which
 * is what that glob reads) or CI — see the brief for why the issue's own "put
 * the sweep in CI" ask does not apply here: the locale sweep it meant is
 * `locales.mjs`, already there.
 *
 *   node shared/test/label-widths.mjs
 *   node shared/test/label-widths.mjs > .claude/work/issue-132/baseline.md
 *
 * ## Why a browser, and why per-locale target isolation
 *
 * `estimateTextWidth` has no DOM and is measured against one that does:
 * `getComputedTextLength()` on an SVG `<text>`, which is what `charts.js`
 * itself draws into. A canvas `measureText` with a guessed font is a second
 * estimator being checked against a first; only the browser's own layout
 * engine, on the app's own font stack, tells you what a reader actually
 * gets.
 *
 * Chrome's locale is NOT this process's `LC_ALL`. `locales.mjs` sets that
 * and re-execs Node, which works there because Node reads its default
 * locale from the environment — but a renderer process does not inherit it,
 * and a Chrome launched under `LC_ALL=fi_FI.UTF-8` has been observed to
 * resolve `Intl` to `en-GB` regardless, which would make this whole sweep
 * ten silent measurements of English. So the locale is driven with CDP
 * `Emulation.setLocaleOverride` instead, per target, and EVERY target is
 * verified before it is trusted: `new Intl.DateTimeFormat().resolvedOptions()
 * .locale` is read back and compared to what was asked for, and a mismatch
 * fails the locale loudly rather than quietly reporting en-US eight times
 * over. Each locale also gets its OWN target (created, measured, closed)
 * rather than one page reused ten times, so nothing about a previous
 * locale's `Intl` formatters — `ui/dates.js` memoises them at module scope —
 * can survive into the next: the module is re-evaluated fresh per target.
 *
 * ## What is measured
 *
 * `ui/dates.js` has no imports, so its source is read, `export` stripped,
 * and evaluated in-page inside an IIFE that returns the functions this file
 * needs — a copy in the sense that the bytes are the same file's, not a
 * hand-maintained duplicate. The labels are the four shapes `charts.js`
 * captions with: weekday names (all three `Intl` widths, since
 * `weekdayMonthChart` and `weekdayChart` each choose a different one),
 * month names, years, and day ranges (both `formatDayRange` styles). The six
 * sizes are every literal font size `charts.js` ever hands `estimateTextWidth`
 * or a variable seeded from one: 8 (`LABEL_FLOOR`, both shrink loops'
 * floor), 8.5 (the month-caption's year annotation), 9.5 (the month caption
 * itself, in both `calendarChart` and `weekdayMonthChart`, and
 * `historyChart`'s fixed `AXIS_SIZE`), 10.5 (`ROW_LABEL_SIZE`, in
 * `calendarChart` and `frequencyChart`), 11 (`weekdayChart`'s `AXIS_SIZE`,
 * before its shrink loop can lower it) and 11.5 (`streakChart`'s
 * `LABEL_SIZE`, same).
 *
 * ## What is reported
 *
 * Per locale: the worst UNDER-estimate ratio (real / estimate, worst when
 * largest — this is the dangerous direction, see decision 2 in the brief)
 * and the worst OVER-estimate ratio (estimate / real, worst when largest —
 * this one only costs pixels). Each is named with the label and size it came
 * from, so a re-run after a fix can be compared sample-for-sample rather
 * than just headline-for-headline.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome } from './browser/chrome.mjs';
// The real export, imported (not the stripped copy `pageScript` builds) —
// used only to print the comparison below, never to compute a measurement.
import { WIDTH_SAFETY } from '../public/ui/dates.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = devtoolsPort(9330);

/**
 * The same ten locales `locales.mjs` sweeps, and for the same reasons — see
 * that file's own comment on each. Kept as a second literal rather than an
 * import because that file's list is a local `const`, not an export;
 * duplicated here as BCP-47 tags (what CDP and `Intl` both want) rather than
 * the glibc `xx_YY.UTF-8` spelling `LC_ALL` wants.
 *
 * The third field is whether a weekday/month name in this locale is expected
 * to use a non-Latin script — which `resolvedLocale === locale` does NOT
 * establish. Measured: Chrome for Testing 152.0.7977.42 resolves `ne-NP`
 * (Nepali) to exactly that tag and then formats every field in the generic
 * ICU root pattern — `Sun`/`Mon`/…, `M01`/`M02`/… — while the SAME
 * `ui/dates.js`, run under Node's full-ICU build with `LC_ALL=ne_NP.UTF-8`,
 * returns Devanagari for every one of them. The locale negotiated; the CLDR
 * DATA for it did not ship. That is a second, quieter way to measure ten
 * English repeats and report them as ten locales, and the resolved-locale
 * check alone cannot see it — so a locale claiming a non-Latin script is
 * additionally required to PRODUCE one, checked below.
 */
const LOCALES = [
  ['en-US', 'the baseline — everything already passes here', false],
  ['fa-IR', 'a non-Gregorian calendar AND non-ASCII digits', true],
  ['ar-EG', 'Arabic-Indic digits, right-to-left, cursive shaping', true],
  ['th-TH', 'the Buddhist era: a Gregorian month with a different year', true],
  ['hi-IN', 'Devanagari script with ASCII digits', true],
  ['ne-NP', 'Devanagari script AND Devanagari digits', true],
  ['bn-IN', 'Bengali digits, the widest of the numeral sets', true],
  ['ja-JP', 'square glyphs and year-first field order', true],
  ['pt-PT', 'long weekday names — the fixed-gutter clipping case', false],
  ['lv-LV', 'the longest date range measured', false],
  // Added for #132 Step 3's own case: the first five below stack a combining
  // vowel sign on a base consonant the way Malayalam does, and none of the
  // original ten does. The deleted test this issue restores cited Malayalam
  // by name (`ബു`, U+0D2C U+0D41) as the worst under-estimate in an earlier
  // corpus, and that corpus is not this one — see the brief. Without these,
  // "worst under-estimate unchanged" is a claim about a sweep that could not
  // have seen the exact case the mark-billing fix reasons about. The sixth,
  // `he-IL`, is legitimate breadth rather than a mark-bearing case — CLDR's
  // Hebrew weekday and month names carry no niqqud, so it exercises
  // right-to-left and a distinct script instead of a combining mark.
  ['ml-IN', 'Malayalam — the deleted test’s own case, abugida with vowel signs', true],
  ['ta-IN', 'Tamil — an abugida with vowel signs, minimal consonant clusters', true],
  ['te-IN', 'Telugu — an abugida with vowel signs, rounder glyphs than Tamil', true],
  ['kn-IN', 'Kannada — an abugida with vowel signs', true],
  ['gu-IN', 'Gujarati — an abugida with vowel signs, no headline stroke', true],
  ['he-IL', 'Hebrew — right-to-left breadth; CLDR weekday/month names carry no niqqud', true],
];

/**
 * Every literal font size `charts.js` ever hands `estimateTextWidth`
 * (directly, or via a variable seeded from one before a shrink loop can
 * lower it) — see the file header for which call site each comes from.
 */
const SIZES = [8, 8.5, 9.5, 10.5, 11, 11.5];

/** The font stack chart SVGs inherit: `style.css:57`, body's own rule. */
const FONT_CSS =
  'font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0;';

const datesSrc = readFileSync(join(here, '..', 'public', 'ui', 'dates.js'), 'utf8')
  .replace(/^export (function|const)/gm, '$1');

/** Mid-month dates, one per month, so a Gregorian AND a non-Gregorian caption
 * both land inside the month they name. */
const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-15`);

const YEAR_SAMPLES = ['2025-06-15', '2026-06-15'];

/**
 * Range pairs chosen to hit the shapes `streakChart` actually feeds
 * `formatDayRange`: a short run inside one month, a month boundary, a YEAR
 * boundary (the exact pair `dates.js`'s own `WIDTH_SAFETY` comment and
 * `charts.js`'s `streakChart` comment both cite for lv-LV), a multi-month
 * streak, and a single-day streak (start === end, `formatDayRange`'s own
 * special case).
 */
const RANGES = [
  ['2026-08-10', '2026-08-16'],
  ['2026-01-28', '2026-02-03'],
  ['2025-12-28', '2026-01-04'],
  ['2026-03-01', '2026-06-15'],
  ['2026-08-16', '2026-08-16'],
];

const profile = mkdtempSync(join(tmpdir(), 'habwidths-'));
const chrome = launchChrome(PORT, profile);

let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

/**
 * One locale's worth of measurement, evaluated in one round trip: the page
 * builds every label with the SAME `ui/dates.js` the app ships, appends each
 * as an SVG `<text>` at each of the six sizes, and reads
 * `getComputedTextLength()` back against `estimateTextWidth`'s own answer for
 * that same text and size.
 *
 * Returned as plain data (`returnByValue`), which is why every value here is
 * a string or a number — nothing that would need a remote handle.
 */
function pageScript() {
  return `
(function () {
  ${datesSrc}
  const Dates = { weekdayNames, formatMonthShort, formatYear, formatDayRange,
    fromISOLocal, estimateTextWidth };

  document.body.setAttribute('style', ${JSON.stringify(FONT_CSS)});
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  document.body.appendChild(svg);

  const labels = [];
  for (const style of ['narrow', 'short', 'long']) {
    for (const t of Dates.weekdayNames(style)) labels.push(['weekday:' + style, t]);
  }
  for (const iso of ${JSON.stringify(MONTHS)}) {
    labels.push(['month', Dates.formatMonthShort(Dates.fromISOLocal(iso))]);
  }
  for (const iso of ${JSON.stringify(YEAR_SAMPLES)}) {
    labels.push(['year', Dates.formatYear(Dates.fromISOLocal(iso))]);
  }
  for (const [a, b] of ${JSON.stringify(RANGES)}) {
    for (const style of ['medium', 'short']) {
      labels.push(['range:' + style,
        Dates.formatDayRange(Dates.fromISOLocal(a), Dates.fromISOLocal(b), style)]);
    }
  }

  const sizes = ${JSON.stringify(SIZES)};
  const out = [];
  for (const [kind, text] of labels) {
    if (!text) continue;
    for (const size of sizes) {
      const node = document.createElementNS(NS, 'text');
      node.setAttribute('font-size', String(size));
      node.textContent = text;
      svg.appendChild(node);
      const real = node.getComputedTextLength();
      svg.removeChild(node);
      out.push({ kind, text, size, real, estimate: Dates.estimateTextWidth(text, size) });
    }
  }
  return { resolvedLocale: new Intl.DateTimeFormat().resolvedOptions().locale, samples: out };
})()`;
}

/** @returns {Promise<{resolvedLocale: string, samples: any[]}>} */
async function measureLocale(locale) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  try {
    // Set BEFORE anything runs in the target: `ui/dates.js`'s formatters are
    // memoised at first call, and a fresh target means there is no earlier
    // call to have memoised one under the wrong locale anyway — belt and
    // braces, since the whole point of this file is not trusting that.
    await send('Emulation.setLocaleOverride', { locale }, sessionId);

    const r = await send('Runtime.evaluate', {
      expression: pageScript(), returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

const out = (s = '') => console.log(s);

let mismatched = 0;
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
out('# Label-width baseline — master, before #132');
out();
out(`Measured ${new Date().toISOString().slice(0, 10)} at commit \`${commit}\`, ` +
  'against `estimateTextWidth` and `WIDTH_SAFETY` as they stand on this tree ' +
  '(no behaviour changed for this measurement — see the brief, Step 1).');
out();
out('`estimateTextWidth` vs `getComputedTextLength()`, six sizes ' +
  `(${SIZES.join(', ')}), ${LOCALES.length} locales, ` +
  `${7 * 3 + MONTHS.length + YEAR_SAMPLES.length + RANGES.length * 2} labels each ` +
  '(weekday×3 widths + months + years + ranges×2 styles).');
out();
out('| locale | resolved | worst under-estimate (real/estimate) | worst over-estimate (estimate/real) |');
out('|---|---|---|---|');

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };

  let overallWorstUnder = null;
  for (const [locale, why, nonLatin] of LOCALES) {
    const { resolvedLocale, samples } = await measureLocale(locale);
    const took = resolvedLocale === locale;
    if (!took) {
      mismatched++;
      out(`| ${locale} | **${resolvedLocale}** ⚠ MISMATCH — see notes below | — | — |  <!-- ${why} -->`);
      continue;
    }

    // The deeper check `resolvedLocale` cannot do: a locale that negotiated
    // correctly but whose weekday/month CLDR data Chrome does not ship falls
    // back to the ASCII root pattern, which this catches by demanding the
    // script it claims.
    const weekdayOrMonth = samples.filter((s) => s.kind.startsWith('weekday') || s.kind === 'month');
    const hasNonAscii = weekdayOrMonth.some((s) => /[^\x00-\x7F]/.test(s.text));
    if (nonLatin && !hasNonAscii) {
      mismatched++;
      out(`| ${locale} | ${resolvedLocale} ⚠ resolved, but CLDR fell back to ASCII (e.g. ` +
        `"${weekdayOrMonth[0]?.text}") | — | — |  <!-- ${why} -->`);
      continue;
    }

    let worstUnder = null, worstOver = null;
    for (const s of samples) {
      if (s.estimate <= 0) continue;
      const ratio = s.real / s.estimate;
      if (!worstUnder || ratio > worstUnder.ratio) worstUnder = { ratio, ...s };
      if (!worstOver || (1 / ratio) > worstOver.ratio) worstOver = { ratio: 1 / ratio, ...s };
    }
    if (!overallWorstUnder || worstUnder.ratio > overallWorstUnder.ratio) {
      overallWorstUnder = { locale, ...worstUnder };
    }

    const fmt = (w) => w
      ? `${w.ratio.toFixed(2)}x — "${w.text}" @ ${w.size}px (real ${w.real.toFixed(1)}, est ${w.estimate.toFixed(1)})`
      : 'n/a';
    out(`| ${locale} | ${resolvedLocale} | ${fmt(worstUnder)} | ${fmt(worstOver)} |  <!-- ${why} -->`);
  }

  out();
  if (mismatched) {
    out(`**${mismatched} locale(s) did not measure anything real in this Chrome build** — ` +
      'either the locale tag itself did not take, or it resolved but the CLDR data behind ' +
      'weekday/month names did not ship (see the rows marked ⚠ above). Their figures are ' +
      'omitted rather than reported as if they measured anything, and excluded from the ' +
      'worst-case figure below.');
  } else {
    out(`All ${LOCALES.length} locales both resolved to the tag they were asked for AND ` +
      'produced the script they claim; every figure above is a real measurement in that ' +
      'locale, not a silent en-US/ASCII repeat.');
  }

  out();
  out(`**Worst under-estimate across every valid locale: ${overallWorstUnder.ratio.toFixed(2)}x** ` +
    `("${overallWorstUnder.text}" @ ${overallWorstUnder.size}px, ${overallWorstUnder.locale}) ` +
    `against \`WIDTH_SAFETY = ${WIDTH_SAFETY}\`. ` +
    (overallWorstUnder.ratio > WIDTH_SAFETY
      ? '**This EXCEEDS WIDTH_SAFETY — master is already clipping a real label in a locale ' +
        'this sweep covers.** See the brief\'s "Stop and report if" clause.'
      : 'This is inside the current margin, so master is not observed clipping any label ' +
        'this sweep covers.'));
} finally {
  await closeChrome({ chrome, port: PORT, profile });
}
