import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { parseSettings, SETTING_VALUES, ValidationError } =
  await import('../src/validate.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- the two registries must agree ---------- */

test('every browser setting is enforced by the server', () => {
  // ui/settings.js declares what the dialog renders; validate.js declares
  // what the server accepts. They are separate because the server must not
  // import browser code — but a key present in one and missing from the
  // other is either an unenforced setting or a dead control.
  const ui = readFileSync(join(root, 'public', 'ui', 'settings.js'), 'utf8');

  // Keys of the SETTINGS object literal, ignoring anything commented out.
  const uiKeys = [...ui.matchAll(/^\s{2}(\w+): \{$/gm)].map((m) => m[1]);

  assert.ok(uiKeys.length > 0, 'failed to parse any settings from ui/settings.js');

  for (const key of uiKeys) {
    assert.ok(
      key in SETTING_VALUES,
      `"${key}" is offered in the UI but the server would reject it — ` +
      'add it to SETTING_VALUES in shared/src/validate.js'
    );
  }
  for (const key of Object.keys(SETTING_VALUES)) {
    assert.ok(
      uiKeys.includes(key),
      `"${key}" is accepted by the server but has no control in the UI`
    );
  }
});

test('every UI option value is one the server accepts', () => {
  const ui = readFileSync(join(root, 'public', 'ui', 'settings.js'), 'utf8');

  // dayOrder is a select; check its declared option values individually.
  const options = [...ui.matchAll(/\{ value: '([^']+)'/g)].map((m) => m[1]);
  for (const value of options) {
    const known = Object.values(SETTING_VALUES).some((vals) => vals.includes(value));
    assert.ok(known, `the UI offers "${value}", which the server would reject`);
  }
});

/* ---------- server-side validation ---------- */

test('valid settings are accepted', () => {
  const { accepted, rejected } = parseSettings({
    dayOrder: 'newest-left', confirmDelete: false,
  });
  assert.deepEqual(accepted, { dayOrder: 'newest-left', confirmDelete: false });
  assert.deepEqual(rejected, []);
});

test('unknown keys are ignored, not fatal', () => {
  // An older server must tolerate a newer client rather than 400 the request.
  const { accepted, rejected } = parseSettings({
    dayOrder: 'newest-left', somethingNew: 'x',
  });
  assert.deepEqual(accepted, { dayOrder: 'newest-left' });
  assert.deepEqual(rejected, ['somethingNew']);
});

test('out-of-range values are rejected', () => {
  const { accepted, rejected } = parseSettings({ dayOrder: 'sideways' });
  assert.deepEqual(accepted, {});
  assert.deepEqual(rejected, ['dayOrder']);
});

test('a toggle must be a real boolean', () => {
  // 'true' and 1 are the classic ways a wrong value reaches an API.
  for (const bad of ['true', 1, 'yes', null]) {
    const { accepted } = parseSettings({ confirmDelete: bad });
    assert.deepEqual(accepted, {}, `confirmDelete accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(parseSettings({ confirmDelete: true }).accepted,
    { confirmDelete: true });
});

test('non-objects are rejected outright', () => {
  for (const bad of ['string', 42, [], null]) {
    assert.throws(() => parseSettings(bad), ValidationError,
      `should reject ${JSON.stringify(bad)}`);
  }
});

test('an empty patch is valid and changes nothing', () => {
  assert.deepEqual(parseSettings({}), { accepted: {}, rejected: [] });
});

test('prototype pollution attempts are dropped', () => {
  // __proto__ is a plain own property after JSON.parse, so it lands in the
  // patch like any other unknown key and must be filtered out.
  const { accepted, rejected } = parseSettings(
    JSON.parse('{"__proto__": {"polluted": true}, "dayOrder": "newest-left"}')
  );
  assert.deepEqual(accepted, { dayOrder: 'newest-left' });
  assert.ok(rejected.includes('__proto__'));
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});
