import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  parseSettings, portableSettings, PORTABLE_SETTINGS, UNPORTABLE_SETTINGS,
  SETTING_VALUES, ValidationError, entryWrite,
} =
  await import('../src/validate.js');
const { computeHistory } = await import('../src/stats.js');

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

/**
 * Slice ui/settings.js into one text block per declared setting, so an option
 * value can be checked against the key that actually offers it.
 *
 * The previous version of this test pooled every `{ value: '…' }` literal in
 * the file and asked whether ANY setting accepted it, which passed happily for
 * a value offered under the wrong key — and could not survive a setting whose
 * legal values are not a list at all.
 */
function uiSettingBlocks(src) {
  const marks = [...src.matchAll(/^ {2}(\w+): \{$/gm)];
  return new Map(marks.map((mark, i) => [
    mark[1],
    src.slice(mark.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
  ]));
}

test('every UI option value is one the server accepts', () => {
  const ui = readFileSync(join(root, 'public', 'ui', 'settings.js'), 'utf8');
  const blocks = uiSettingBlocks(ui);
  assert.ok(blocks.size > 0, 'failed to parse any settings from ui/settings.js');

  let checked = 0;
  for (const [key, block] of blocks) {
    const values = [...block.matchAll(/\{ value: '([^']*)'/g)].map((m) => m[1]);
    // A `multi` setting's control offers one value at a time but stores a list,
    // so each option is submitted the way the client would submit it.
    const isMulti = /type: 'multi'/.test(block);

    for (const value of values) {
      const patch = { [key]: isMulti ? [value] : value };
      assert.deepEqual(
        parseSettings(patch).rejected, [],
        `the UI offers ${JSON.stringify(value)} for "${key}", which the server rejects`
      );
      checked++;
    }
  }
  assert.ok(checked > 0, 'no option values were checked — has the format changed?');
});

test('a setting whose values are not a list is still enforced', () => {
  // notifyTimezone and discordWebhook cannot be enumerated, so they carry a
  // normaliser instead of an array. The point of this test is that the two
  // rule forms live behind one door: parseSettings.
  const shapes = Object.values(SETTING_VALUES).map((rule) => typeof rule);
  assert.ok(shapes.includes('function'), 'expected at least one normaliser rule');
  assert.ok(shapes.includes('object'), 'expected at least one enumerated rule');

  // A normaliser may store something other than what arrived; an array rule
  // never does. Both are decided here and nowhere else.
  const { accepted } = parseSettings({
    discordWebhook: 'https://discord.com/api/webhooks/1/abc?wait=true',
  });
  assert.equal(accepted.discordWebhook, 'https://discord.com/api/webhooks/1/abc');
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

test('every historyGranularity value is one the aggregator understands', () => {
  // computeHistory falls back to 'day' for an unknown bucket rather than
  // throwing, so a typo here would produce a setting that saves fine, passes
  // validation, and then silently does nothing.
  const habit = {
    type: 'boolean', target_value: 0, target_type: 'at_least',
    freq_numerator: 1, freq_denominator: 1,
  };
  const entries = new Map([
    ['2026-01-15', { value: 2, status: '' }],
    ['2026-04-20', { value: 2, status: '' }],
  ]);

  const dayBuckets = computeHistory(habit, entries, '2026-01-01', '2026-06-30', 'day');

  for (const g of SETTING_VALUES.historyGranularity) {
    const buckets = computeHistory(habit, entries, '2026-01-01', '2026-06-30', g);
    if (g === 'day') continue;
    // Any real bucketing groups days together, so it must produce strictly
    // fewer buckets than one-per-day. An unrecognised value would fall back
    // to 'day' and match it exactly.
    assert.ok(
      buckets.length < dayBuckets.length,
      `"${g}" produced ${buckets.length} buckets, the same as day-level — ` +
      'it is not a bucket computeHistory knows, so the setting would do nothing'
    );
  }
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

/* ---------- what a write actually does to storage ---------- */

const SENTINELS = { UNSET: 0, YES: 2, SKIP: 3 };

test('a skip is stored out of band and reported as the wire value', () => {
  const write = entryWrite({ type: 'numerical' },
    { value: 0, status: 'skip', notes: 'ill' }, SENTINELS);
  assert.equal(write.op, 'upsert');
  assert.equal(write.status, 'skip');
  assert.equal(write.value, 0, 'never the SKIP value — a numerical habit may record 3');
  assert.equal(write.reply.value, 3, 'but the API answers with the wire value');
});

test('a stated "not done" is a row, so it can be told from an unanswered day', () => {
  // This used to delete. A row is an answer: keeping one is what lets `?` mean
  // "nobody has said" rather than "not done", and it is what an imported Loop NO
  // becomes. DELETE is the verb that means "nothing is known" now.
  const write = entryWrite({ type: 'boolean' },
    { value: 0, status: '', notes: '' }, SENTINELS);
  assert.equal(write.op, 'upsert');
  assert.equal(write.value, 0);
  assert.equal(write.status, '');
  assert.equal(write.reply.value, 0);
});

test('a note rides along with it, as it always did', () => {
  const write = entryWrite({ type: 'boolean' },
    { value: 0, status: '', notes: 'travelling' }, SENTINELS);
  assert.equal(write.op, 'upsert');
  assert.equal(write.value, 0);
  assert.equal(write.notes, 'travelling');
});

test('nothing entryWrite can return is a delete', () => {
  // Three callers switch on `op` — both editions' PUT routes and the Discord
  // button handler — and every one of them now only ever upserts. If a future
  // change reintroduces a delete here, the DELETE route is where it belongs.
  const cases = [
    [{ type: 'boolean' }, { value: 0, status: '', notes: '' }],
    [{ type: 'boolean' }, { value: 2, status: '', notes: '' }],
    [{ type: 'boolean' }, { value: 0, status: 'skip', notes: '' }],
    [{ type: 'numerical' }, { value: 0, status: '', notes: '' }],
    [{ type: 'numerical' }, { value: 7.5, status: '', notes: 'x' }],
  ];
  for (const [habit, parsed] of cases) {
    assert.equal(entryWrite(habit, parsed, SENTINELS).op, 'upsert',
      `${habit.type} ${JSON.stringify(parsed)}`);
  }
});

test('a numerical zero is a recorded amount, not an absence', () => {
  // "at most 0 cigarettes" is met by recording 0, which must not be deleted as
  // if it had never been answered.
  const write = entryWrite({ type: 'numerical' },
    { value: 0, status: '', notes: '' }, SENTINELS);
  assert.equal(write.op, 'upsert');
  assert.equal(write.value, 0);
});

/* ---------- what a backup may carry ---------- */

test('every setting is classified as portable or not', () => {
  // The list a backup writes and reads is an allowlist, so a setting added later
  // travels only once someone has decided it should. This is the thing that
  // forces the decision: a new key in neither list fails here rather than
  // silently defaulting to "goes in the file", which for a credential-shaped
  // value is the wrong default to have by accident.
  const classified = new Set([...PORTABLE_SETTINGS, ...UNPORTABLE_SETTINGS]);
  const unclassified = Object.keys(SETTING_VALUES).filter((k) => !classified.has(k));
  assert.deepEqual(unclassified, [],
    'add each of these to PORTABLE_SETTINGS or UNPORTABLE_SETTINGS in validate.js');

  for (const key of classified) {
    assert.ok(Object.hasOwn(SETTING_VALUES, key), `${key} is not a setting at all`);
  }
  assert.deepEqual(
    PORTABLE_SETTINGS.filter((k) => UNPORTABLE_SETTINGS.includes(k)), [],
    'a setting cannot be both');
});

test('a backup carries no notification destination, in either direction', () => {
  // A backup file is emailed, synced and attached to bug reports, and
  // `discordWebhook` is a bearer capability for a channel. Out: it would sit in
  // every copy of the file. In: a shared "starter habits" backup could repoint
  // the reminders of everyone who restored it at a channel its author reads.
  const full = {
    dayOrder: 'newest-right',
    skipDays: true,
    questionMarks: true,
    notifyChannels: ['discord'],
    discordWebhook: 'https://discord.com/api/webhooks/1/abc',
    discordChannelId: '123456789012345678',
    discordUserId: '123456789012345678',
    notifyTimezone: 'Europe/Berlin',
  };

  const portable = portableSettings(full);
  assert.deepEqual(portable,
    { dayOrder: 'newest-right', skipDays: true, questionMarks: true });

  for (const key of UNPORTABLE_SETTINGS) {
    assert.ok(!Object.hasOwn(portable, key), `${key} survived the filter`);
  }

  // Absent keys stay absent rather than arriving as undefined, so a restore
  // cannot blank a setting the file simply did not mention.
  assert.deepEqual(portableSettings({ skipDays: false }), { skipDays: false });
  assert.deepEqual(portableSettings({}), {});
  assert.deepEqual(portableSettings(), {});
});

test('the filter is not fooled by a prototype key', () => {
  // The same reasoning as parseSettings' own guard: this reads keys from a file.
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "skipDays": true}');
  assert.deepEqual(portableSettings(hostile), { skipDays: true });
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});
