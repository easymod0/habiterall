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
const { computeHistory, UNLOGGED_DEFAULT } = await import('../src/stats.js');
// Importable under Node because it has no imports of its own — deliberately,
// so the browser can load it with no build step. That makes the registry
// itself testable rather than only greppable.
const { SETTINGS, defaults } = await import('../public/ui/settings.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- the two registries must agree ---------- */

test('the registry default for atMostUnlogged is the one the arithmetic uses', () => {
  // Three copies of one default — this registry, `UNLOGGED_DEFAULT` in
  // stats.js, and `AppSettings` on the phone (pinned by its own
  // AppSettingsDefaultsTest) — because `GET /settings` returns only the keys
  // that have been stored, so every reader has to supply its own answer for a
  // setting nobody has touched.
  //
  // The one that drifted before was `historyGranularity`, and it drifted the
  // expensive way: a screen showing a value the charts were not using. Here it
  // would be worse than cosmetic — the dialog would say a limit's unlogged
  // days count as a miss while the streak was computed as though they did not.
  const ui = readFileSync(join(root, 'public', 'ui', 'settings.js'), 'utf8');
  const block = ui.slice(ui.indexOf('\n  atMostUnlogged: {'));
  const shown = /\n\s*default:\s*'([^']+)'/.exec(block.slice(0, block.indexOf('\n  },')));

  assert.ok(shown, 'atMostUnlogged has no default in ui/settings.js');
  assert.equal(shown[1], UNLOGGED_DEFAULT,
    'the dialog would show a value the score is not computed with');
  assert.ok(SETTING_VALUES.atMostUnlogged.includes(UNLOGGED_DEFAULT),
    'the default is not a value the server would even accept');
});

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


/* ---------- a default must satisfy its own rule ---------- */

/**
 * The control shapes `renderSettingsBody` knows how to draw, and `isValid`
 * knows how to check.
 *
 * Written down here rather than inferred, because a type neither of them
 * recognises is silent at both ends: the dialog falls through to its final
 * `else` and draws a checkbox, and `isValid` returns `false` for every value,
 * so the setting cannot be stored and reverts to its default on every load with
 * nothing anywhere saying why.
 */
const CONTROL_TYPES = ['select', 'toggle', 'multi', 'text'];

test('every registry default is a value the registry itself accepts', () => {
  // The bug this is written for shipped and was caught by review, not by a
  // test: `notifyTimezone`'s default became `auto` while its `validate`
  // (`knownTimeZone`) special-cased only `''`, so the default failed its own
  // check. Invisible online — `sanitise` throws the invalid value away and
  // substitutes the default, which is the same string — and visible offline as
  // "Not saved: Reminder timezone" over a write that had already been queued.
  //
  // Asked of every key rather than that one, because the shape recurs: any
  // `select` whose default is missing from `options`, any `toggle` defaulting
  // to a string, any `validate` that forgets a new state.
  //
  // **Every rule that APPLIES, not the first one that matches.** This was an
  // `if/else if` chain with `def.validate` at its head, so a key carrying one
  // never reached the option-membership check below — and `notifyTimezone` is
  // the only key that carries one, which is to say the single entry this test
  // was WRITTEN for was the single entry exempt from half of it. Measured:
  // dropping the `{value: 'auto', …}` entry from `timeZoneOptions()` while
  // leaving `default: 'auto'` passed the whole suite and every browser suite, a
  // default its own control cannot offer. `validate` is an ADDITIONAL rule for
  // a value whose legal set is not a list; it was never a substitute for the
  // list. Two `if`s, no `else`.
  //
  // The consequence today is only cosmetic — `settings-dialog.js` prepends a
  // synthetic option for a draft value the list does not carry, so nothing is
  // silently rewritten — but a default the registry cannot express is exactly
  // what this exists to catch, and normaliser-form settings are where new
  // options are currently landing.
  //
  // ONE SHAPE IS OUT OF THIS LOOP, and it is worth writing down precisely
  // because what currently catches it is a coincidence. Retyping
  // `notifyTimezone` to `text` and deleting its options satisfies every rule
  // below: its `SETTING_VALUES` rule is a normaliser rather than an
  // enumeration, so rule 4 has nothing to compare against, and its own
  // `validate` goes on holding — which is the point, since values stay checked
  // by `knownTimeZone` at both ends and only the CONTROL degrades, from a list
  // of zones to a box you type `Europe/Berlin` into. That is a rendering
  // regression and not a data one, and a registry-only test cannot tell it from
  // a text field somebody meant.
  //
  // Measured, it does fail the suite today — but in `every option a control
  // offers…`, on that test's `checked > 0` floor, because `notifyTimezone` is
  // the ONLY key carrying both a validate and an options list and deleting them
  // leaves it nothing to check. That catch evaporates the moment a second such
  // key lands. Recorded, not relied on.
  for (const [key, def] of Object.entries(SETTINGS)) {
    const value = def.default;
    assert.notEqual(value, undefined, `${key} has no default`);

    // 0. A type the dialog can actually render, asked FIRST because everything
    // below is keyed on it — an unrecognised one matches no branch, so the loop
    // runs and checks nothing, which is the `else if` defect one field over.
    // Measured: retyping `confirmDelete` from `toggle` to `text`, or to a
    // `checkbox` that does not exist, leaves the whole unit suite green while
    // `isValid` refuses every stored value, so the setting silently reverts to
    // its default on every load — `load().confirmDelete` answers `true` with
    // `false` stored.
    assert.ok(CONTROL_TYPES.includes(def.type),
      `${key}: control type ${JSON.stringify(def.type)} is not one the dialog renders`);

    // 1. Its own validator, for a legal set that cannot be enumerated.
    if (def.validate) {
      assert.ok(def.validate(value),
        `${key}: the default ${JSON.stringify(value)} fails its own validate()`);
    }

    // 2. Its type's rule. Both of the types whose default has a shape of its
    // own — a toggle is a real boolean, free text is a string. `isValid` tests
    // exactly these, so a default that fails here is one the cache throws away.
    if (def.type === 'toggle') {
      assert.equal(typeof value, 'boolean', `${key}: a toggle defaulting to ${typeof value}`);
    }
    if (def.type === 'text') {
      assert.equal(typeof value, 'string', `${key}: free text defaulting to ${typeof value}`);
    }

    // 3. And membership, wherever there is a list to be a member of. Gated on
    // the OPTIONS and not on the absence of a `validate`, which is the whole
    // correction: the question is whether the control offers a list, and a
    // `validate` says nothing about that. A `text` control — a webhook URL, an
    // ntfy topic — has no list and is checked by the server, which is the only
    // check that counts for it.
    if (def.type === 'select' || def.type === 'multi') {
      // ...and it must HAVE one, or the check above could be dodged by
      // deleting the list rather than by fixing the default. `renderSettingsBody`
      // dereferences `def.options` for both of these types anyway, so a missing
      // list is a dialog that throws.
      assert.ok(Array.isArray(def.options),
        `${key}: a ${def.type} with no options — the dialog cannot render it`);
    }

    if (Array.isArray(def.options)) {
      // ...and the other way round, which closes the way OUT of the check
      // above: retype a `select` as `text` and leave its options in place and
      // the membership rule below still runs, but the control renders as a free
      // text box and `isValid` degrades to "any string". Options mean one
      // thing, and the dialog reads them for two types.
      assert.ok(def.type === 'select' || def.type === 'multi',
        `${key}: a ${def.type} carrying options — only a select or a multi is `
        + 'rendered from a list');

      const offers = (v) => def.options.some((o) => o.value === v);
      if (def.type === 'multi') {
        assert.ok(Array.isArray(value) && value.every(offers),
          `${key}: the default ${JSON.stringify(value)} is not a subset of its options`);
      } else {
        assert.ok(offers(value),
          `${key}: the default ${JSON.stringify(value)} is not one of its options`);
      }
    }

    // 4. And the last way out: retype a `select` as `text` AND delete its
    // options, and every rule above is satisfied by a string default. The
    // registry alone cannot tell that from a legitimate text field, so this
    // asks the SERVER, which is the only other opinion there is — a key whose
    // rule in `SETTING_VALUES` is an enumeration has a list, and a control that
    // offers a list is a select, a multi or a toggle. It says nothing about the
    // normaliser-form keys, which are legitimately either.
    if (Array.isArray(SETTING_VALUES[key])) {
      assert.ok(['select', 'multi', 'toggle'].includes(def.type),
        `${key}: the server enumerates its values, so the control must offer `
        + `them — a ${def.type} box would take anything`);
    }
  }
});

test('every option a control offers is one its own validator accepts', () => {
  // The other half of "a default must satisfy its own rule", and the half the
  // test above cannot reach: it checks ONE value, the default, so a `validate`
  // and an `options` list that disagree anywhere else go unnoticed. For
  // `notifyTimezone` — the only key with both — the default satisfies both
  // lists by luck rather than by construction, since `auto` was added to
  // `knownTimeZone` and to `timeZoneOptions()` in two separate edits.
  //
  // An option the control offers that its own validator refuses is a control
  // you cannot use: `sanitise` throws the chosen value away and substitutes the
  // default, so picking it appears to do nothing. Cheap enough to ask of every
  // option rather than of the default alone — the whole registry is a few
  // hundred values, measured in tens of milliseconds.
  let checked = 0;
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (!def.validate || !Array.isArray(def.options)) continue;
    for (const option of def.options) {
      assert.ok(def.validate(option.value),
        `${key}: the control offers ${JSON.stringify(option.value)}, which its `
        + 'own validate() refuses — choosing it would silently do nothing');
      checked++;
    }
  }
  assert.ok(checked > 0, 'no key has both a validate and an options list');
});

test('every registry default is a value the SERVER accepts', () => {
  // The other half, and the one that decides what is actually stored. A
  // default the server refuses means the very first write of that key is
  // dropped — and `parseSettings` reports it in `ignored`, which the dialog
  // turns into "Not saved".
  const { accepted, rejected } = parseSettings(defaults());
  assert.deepEqual(rejected, [], `the server refuses its own defaults: ${rejected}`);
  for (const [key, value] of Object.entries(defaults())) {
    assert.deepEqual(accepted[key], value,
      `${key}: the server normalised its own default to ${JSON.stringify(accepted[key])}`);
  }
});
