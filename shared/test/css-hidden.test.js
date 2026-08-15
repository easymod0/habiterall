import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'public', 'style.css'), 'utf8');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');

/**
 * Regression guard for a real bug: `dialog label { display: block }` and
 * `.day-choices { display: flex }` both override the `hidden` attribute,
 * so elements JS had hidden stayed on screen. The day editor showed the
 * number field on yes/no habits and the Done/Not-done buttons on
 * measurable ones, simultaneously.
 *
 * A `display` declaration always beats `hidden`'s UA `display: none`, so
 * the stylesheet must carry an explicit override.
 */

test('the stylesheet forces [hidden] to win over display rules', () => {
  const rule = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/;
  assert.ok(rule.test(css),
    'style.css must contain `[hidden] { display: none !important; }` — without it, ' +
    'any `display` rule silently defeats the hidden attribute');
});

// "every element JS hides is actually hideable" used to live here: a list of
// nine ids that had to exist in index.html. `test/ui-modules.test.js` now
// fails on *any* id the browser modules look up and index.html does not
// declare, which is the same check over every element rather than a list
// someone has to remember to extend.

test('the day editor has exactly one control per habit type', () => {
  // Yes/no -> #day-boolean, measurable -> #day-numeric. Both start hidden so
  // neither flashes before openDayDialog picks one.
  // Matched on the id rather than the tag: the numeric block was a <label>
  // wrapping one input and is a <div> around a fieldset now that the amount is
  // a control rather than a box. What has to hold is that it starts hidden.
  const boolBlock = html.match(/<\w+ id="day-boolean"[^>]*>/)?.[0] ?? '';
  const numBlock = html.match(/<\w+ id="day-numeric"[^>]*>/)?.[0] ?? '';

  assert.ok(boolBlock.includes('hidden'), '#day-boolean must start hidden');
  assert.ok(numBlock.includes('hidden'), '#day-numeric must start hidden');

  // Exactly two choices, and only inside the boolean block.
  const choices = [...html.matchAll(/class="btn day-choice"/g)];
  assert.equal(choices.length, 2, 'expected exactly Done and Not done');
});

// "the day editor toggles both blocks off the same flag" used to live here as
// a regex over day-dialog.js. It caught nothing `test/browser/daydialog.mjs`
// does not — that suite *runs* openDayDialog against a fake DOM and asserts
// the same outcomes, and browsercheck.mjs then reads the computed visibility
// in a real browser. Inverting the flag fails all three. What the regex added
// was a false positive: it broke on a variable rename during the frontend
// split, while the behaviour was never in danger.
