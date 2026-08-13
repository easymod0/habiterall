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

test('every element JS hides is actually hideable', () => {
  // Elements toggled via `.hidden` in app.js that also match a CSS selector
  // setting `display` would break without the guard above.
  const jsHidden = [
    'day-boolean', 'day-numeric', 'day-save', 'day-clear',
    'import-result', 'empty', 'view-list', 'view-detail', 'toast',
  ];

  for (const id of jsHidden) {
    assert.ok(html.includes(`id="${id}"`),
      `#${id} is toggled from app.js but is missing from index.html`);
  }
});

test('the day editor has exactly one control per habit type', () => {
  // Yes/no -> #day-boolean, measurable -> #day-numeric. Both start hidden so
  // neither flashes before openDayDialog picks one.
  const boolBlock = html.match(/<div id="day-boolean"[^>]*>/)?.[0] ?? '';
  const numBlock = html.match(/<label id="day-numeric"[^>]*>/)?.[0] ?? '';

  assert.ok(boolBlock.includes('hidden'), '#day-boolean must start hidden');
  assert.ok(numBlock.includes('hidden'), '#day-numeric must start hidden');

  // Exactly two choices, and only inside the boolean block.
  const choices = [...html.matchAll(/class="btn day-choice"/g)];
  assert.equal(choices.length, 2, 'expected exactly Done and Not done');
});

test('app.js toggles both day-editor blocks off the same flag', () => {
  const app = readFileSync(join(root, 'public', 'app.js'), 'utf8');

  assert.ok(/els\.dayBoolean\.hidden\s*=\s*numeric/.test(app),
    'the boolean block must be hidden when the habit is numerical');
  assert.ok(/els\.dayNumeric\.hidden\s*=\s*!numeric/.test(app),
    'the numeric block must be hidden when the habit is boolean');
});
