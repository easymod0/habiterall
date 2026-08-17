/**
 * Run the date suites in somebody else's locale.
 *
 * Every defect this repository has found in `ui/dates.js` was invisible to a
 * suite running in en-US, and each was found by a person changing their own
 * machine rather than by CI:
 *
 *   - `monthLabels()` indexed by `getMonth()` passes 12/12 in en-US and
 *     pt-PT, and only fails where the calendar is not Gregorian.
 *   - `String(d.getDate())` in the dashboard header is right in every locale
 *     that uses ASCII digits and a Gregorian calendar, which is most of the
 *     ones anyone tests in.
 *   - the width estimator's digit rates were measured in one locale and billed
 *     Devanagari numerals at 1.77x, which shows up as a shrunken font and not
 *     as an error.
 *
 * `dates.test.js` is written to compare against `Intl` given the same date
 * rather than against literals, which is what makes running it under another
 * locale meaningful at all: the assertions do not need rewriting per locale,
 * they simply have more to disagree about.
 *
 * Node takes its default locale from the environment, so this is `LC_ALL` and
 * a subprocess — no test-only hook in the module under test, and nothing to
 * remember to keep in step.
 *
 *   node shared/test/locales.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The locales, and each is here for a property rather than for coverage.
 *
 * A sweep of all 700-odd would be slower and say less: what matters is that
 * every WAY a locale can differ from en-US is represented, because that is
 * what a hardcoded table or an ASCII assumption trips over.
 */
const LOCALES = [
  ['en_US.UTF-8', 'the baseline — everything already passes here'],
  ['fa_IR.UTF-8', 'a non-Gregorian calendar AND non-ASCII digits'],
  ['ar_EG.UTF-8', 'Arabic-Indic digits, right-to-left, cursive shaping'],
  ['th_TH.UTF-8', 'the Buddhist era: a Gregorian month with a different year'],
  ['hi_IN.UTF-8', 'Devanagari script with ASCII digits'],
  ['ne_NP.UTF-8', 'Devanagari script AND Devanagari digits'],
  ['bn_IN.UTF-8', 'Bengali digits, the widest of the numeral sets'],
  ['ja_JP.UTF-8', 'square glyphs and year-first field order'],
  ['pt_PT.UTF-8', 'long weekday names — the fixed-gutter clipping case'],
  ['lv_LV.UTF-8', 'the longest date range measured'],
];

const SUITES = ['dates.test.js', 'calendar.test.js', 'window.test.js'];

/**
 * ...and the chart suites that build their own DOM, which is where a locale
 * costs a LAYOUT rather than a string.
 *
 * `weekcheck` measures rendered gutters, captions and label positions against
 * what the estimator reserved, and every one of those is locale-shaped: the
 * row-gutter CEILING binds in ten locales at 328px and in none in English, so
 * running it only in the runner's locale pinned the one case where the bound
 * never applies. They need no browser and no server, which is what lets them
 * run ten more times without a machine noticing.
 */
const SCRIPT_SUITES = ['browser/weekcheck.mjs'];

let failed = 0;
for (const [locale, why] of LOCALES) {
  const env = { ...process.env, LC_ALL: locale, LANG: locale };
  const runs = [
    spawnSync(process.execPath, ['--test', ...SUITES.map((f) => join(here, f))],
      { env, encoding: 'utf8' }),
    ...SCRIPT_SUITES.map((f) =>
      spawnSync(process.execPath, [join(here, f)], { env, encoding: 'utf8' })),
  ];
  const res = { status: runs.every((r) => r.status === 0) ? 0 : 1 };
  const out = runs.map((r) => `${r.stdout ?? ''}${r.stderr ?? ''}`).join('\n');
  // The locale has to have actually taken, or this is ten runs of en-US
  // reporting ten passes. ICU falls back silently for a name it does not know,
  // which is precisely how a sweep comes to prove nothing.
  const resolved = spawnSync(process.execPath,
    ['-e', 'process.stdout.write(new Intl.DateTimeFormat().resolvedOptions().locale)'],
    { env: { ...process.env, LC_ALL: locale, LANG: locale }, encoding: 'utf8' }).stdout;
  const wanted = locale.split('.')[0].replace('_', '-');
  const took = resolved === wanted;

  const ok = res.status === 0 && took;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${locale.padEnd(13)} ${why}` +
    (took ? '' : `  [resolved to ${resolved}, not ${wanted}]`));
  if (res.status !== 0) {
    console.log(out.split('\n').filter((l) => /^not ok|^FAIL|Error|expected|actual/.test(l))
      .slice(0, 12).map((l) => `        ${l}`).join('\n'));
  }
}

console.log(failed
  ? `\n${failed} locale(s) failed`
  : `\nall ${LOCALES.length} locales passed`);
process.exit(failed ? 1 : 0);
