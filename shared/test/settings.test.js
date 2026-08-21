import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  parseSettings, portableSettings, PORTABLE_SETTINGS, UNPORTABLE_SETTINGS,
  SETTING_VALUES, ValidationError, entryWrite, parseCardList, DETAIL_CARDS,
} =
  await import('../src/validate.js');
const { computeHistory, UNLOGGED_DEFAULT } = await import('../src/stats.js');
// Importable under Node because it has no imports of its own — deliberately,
// so the browser can load it with no build step. That makes the registry
// itself testable rather than only greppable.
const { SETTINGS, defaults, init, reset, storedShapeIsStale } =
  await import('../public/ui/settings.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// `init`/`reset` read and write `localStorage` as a first-paint cache; under
// plain Node there is none, so a minimal in-memory stand-in is enough to let
// them run at all. Module-scoped rather than per-test: `node --test` isolates
// each FILE into its own process, so nothing here can leak into another test
// file, and nothing else in this one touches it.
const memoryStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (memoryStorage.has(k) ? memoryStorage.get(k) : null),
  setItem: (k, v) => memoryStorage.set(k, String(v)),
  removeItem: (k) => memoryStorage.delete(k),
};

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
    // A `multi` setting's control offers one value at a time but stores a
    // list, so each option is submitted the way the client would submit it.
    // `ordered-multi` stores the NEW SHAPE, so it is submitted as one
    // `{id, on}` entry — a bare string here is the legacy read and would pass
    // for the wrong reason.
    const isMulti = /type: 'multi'/.test(block);
    const isOrderedMulti = /type: 'ordered-multi'/.test(block);

    for (const value of values) {
      const patch = {
        [key]: isOrderedMulti ? [{ id: value, on: true }] : isMulti ? [value] : value,
      };
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

/* ---------- a Save migrates a stale-shaped value (#163 review round 1) ---------- */

test('storedShapeIsStale answers only for a value the server named, and only ' +
  'when its own normaliser would rewrite it', async (t) => {
  // This is the WIRING behind FIX 1's `applyDraft` addition, exercised directly
  // rather than through a browser: `ui/settings.js` has no imports of its own
  // (see the module comment above), so `init`/`reset` run under plain Node once
  // `fetch` is stubbed. It is NOT the browser-suite migration test the fix
  // brief asks for — that needs a genuinely legacy value sitting in the
  // SERVER's store, and there is no honest way to put one there: every write
  // path in both editions (`PUT /api/settings`, and `POST /import` in replace
  // mode) runs the value through `parseSettings`/`parseCardList` before it
  // touches storage, so nothing reachable over HTTP can leave a bare-string
  // `detailCards` behind. `shared/test/browser/settingscheck.mjs` covers the
  // half that IS reachable from there — that a no-op Save on an
  // already-current value writes nothing.
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const serveSettings = (body) => {
    globalThis.fetch = async () => ({ ok: true, json: async () => body });
  };

  // Nothing has ever been said about detailCards yet in this process — an
  // absent key must not read as stale, or a fresh account would rewrite its
  // own default back at its very first Save.
  assert.equal(storedShapeIsStale('detailCards'), false,
    'a key the server has never named must not be reported as stale');

  // The server hands back a genuinely legacy, bare-string value.
  serveSettings({ detailCards: ['calendar', 'history'] });
  await init();
  assert.equal(storedShapeIsStale('detailCards'), true,
    'a legacy bare-string value is exactly what this predicate exists to catch');

  // A key with no normaliser at all — `theme` — is never stale, whatever the
  // server says, because there is no rewritten shape to compare it against.
  assert.equal(storedShapeIsStale('theme'), false,
    'a key with no normaliser has nothing for this predicate to say');

  // The server now hands back the new (canonical) shape — what this build
  // itself would have written. Nothing left to migrate.
  serveSettings({ detailCards: SETTINGS.detailCards.default });
  await init();
  assert.equal(storedShapeIsStale('detailCards'), false,
    'a value already in the shape the normaliser produces is not stale');

  // `reset()` tells the account it now holds nothing at all — re-seed the
  // legacy value, confirm it reads stale, then reset and confirm the flag
  // clears rather than sticking forever.
  serveSettings({ detailCards: ['calendar', 'history'] });
  await init();
  assert.equal(storedShapeIsStale('detailCards'), true);
  await reset();
  assert.equal(storedShapeIsStale('detailCards'), false,
    'a reset account has nothing stored, so nothing can be stale');
});

/* ---------- which detail cards a page shows ---------- */

test('a legacy list means membership is visibility, and carries NO order of its own', () => {
  // LEGACY: a bare list of ids meant "these are ticked" and nothing about
  // their SEQUENCE. Master's own `parseCardList` was
  // `DETAIL_CARDS.filter((id) => raw.includes(id))`, so every legacy value
  // that can be in storage is already a canonical-order subset — there is no
  // ordering decision recorded in `['history', 'calendar']` to preserve.
  // Reading the given order used to rearrange the page the moment a card was
  // re-ticked (master drew Habit strength, Calendar, History; re-ticking
  // `strength` on the old rule drew Calendar, History, Habit strength
  // instead) — so this reads for membership alone: all nine in
  // `DETAIL_CARDS` order, `on` set by whether the id was mentioned, which
  // reproduces exactly the page master drew.
  assert.deepEqual(parseCardList(['history', 'calendar']),
    DETAIL_CARDS.map((id) => ({ id, on: id === 'history' || id === 'calendar' })),
    'a legacy list must be read in DETAIL_CARDS order, not the order it lists ids in');

  // `[]` is the single most important case here: it must NOT be read as the
  // new shape (an empty array of objects, meaning "nothing mentioned to
  // hide", which would invert to everything visible). Unticking everything
  // has to keep meaning nothing visible.
  assert.deepEqual(parseCardList([]), DETAIL_CARDS.map((id) => ({ id, on: false })),
    'an empty legacy list must leave every card off, not turn every card on');

  // A card that shipped AFTER a legacy value was stored is off, and that is
  // the deliberate policy rather than an oversight — "a legacy account is read
  // tolerantly, and migrated only by a deliberate Done". Asserted as a literal
  // `false` on the newest card, because the two derived assertions above are
  // both built from DETAIL_CARDS and would keep passing if the legacy branch
  // started defaulting an unmentioned id to ON.
  assert.deepEqual(
    parseCardList(['history']).find((c) => c.id === 'recentDays'),
    { id: 'recentDays', on: false },
    'a card newer than a legacy stored value stays off until a deliberate Done'
  );
});

test('a new-shape list keeps its own order, and a card left out is inserted at its canonical position', () => {
  // Deliberately non-canonical, with two cards off — a fixture that only
  // varies membership would pass with the order silently dropped.
  const shuffled = [
    { id: 'frequency', on: true },
    { id: 'strength', on: false },
    { id: 'history', on: true },
    // Deliberately NOT first, though it is first in DETAIL_CARDS: a card whose
    // canonical position is index 0 is exactly the one whose stored order
    // would be silently "corrected" by a normaliser that reordered at all.
    { id: 'recentDays', on: true },
    { id: 'weekdayMonths', on: false },
    { id: 'awards', on: true },
    { id: 'calendar', on: true },
    { id: 'streaks', on: true },
    { id: 'resilience', on: true },
    { id: 'weekdays', on: true },
  ];
  assert.deepEqual(parseCardList(shuffled), shuffled,
    'a new-shape list naming every card must come back verbatim, in its own order');

  // Missing exactly one id: 'calendar'. It must be inserted immediately after
  // its DETAIL_CARDS predecessor, 'strength' — asserted by INDEX, not just
  // membership, or the card could land anywhere and still pass.
  const missingCalendar = DETAIL_CARDS
    .filter((id) => id !== 'calendar')
    .map((id) => ({ id, on: true }));
  const result = parseCardList(missingCalendar);
  const insertedAt = result.findIndex((c) => c.id === 'calendar');
  assert.equal(insertedAt, 2, 'calendar must land right after strength, its canonical predecessor');
  assert.deepEqual(result[insertedAt], { id: 'calendar', on: true });

  // The card at DETAIL_CARDS index 0 has NO predecessor to land after, which
  // is a different branch — `predecessorIndex` is -1 and the insert falls back
  // to the front. A tenth card shipping at the top of the page is exactly how
  // an existing account gets it with no migration, so it is asserted by index
  // rather than left to the general case above.
  const missingFirst = DETAIL_CARDS
    .filter((id) => id !== 'recentDays')
    .map((id) => ({ id, on: true }));
  const withFirst = parseCardList(missingFirst);
  assert.equal(withFirst.findIndex((c) => c.id === 'recentDays'), 0,
    'a card with no canonical predecessor must land at the front');
  assert.deepEqual(withFirst[0], { id: 'recentDays', on: true });

  // ...and a RUN of missing leading ids lands as a run, in order. The loop
  // walks DETAIL_CARDS, so by the time 'strength' looks for its predecessor
  // 'recentDays' has already been inserted — which is the only reason the two
  // do not both pile up at index 0 in the wrong order.
  const missingBoth = DETAIL_CARDS
    .filter((id) => id !== 'recentDays' && id !== 'strength')
    .map((id) => ({ id, on: true }));
  assert.deepEqual(parseCardList(missingBoth).slice(0, 2),
    [{ id: 'recentDays', on: true }, { id: 'strength', on: true }],
    'consecutive missing ids must land as a run, in DETAIL_CARDS order');
});

test('dupes collapse first-wins, unknown ids and __proto__ are dropped, and a mixed list is refused', () => {
  // Legacy (string) form. The expected value is written out rather than
  // produced by a second call to parseCardList — both sides calling the
  // function under test would let a parseCardList broken in the same way on
  // both inputs pass. A legacy list carries no order (see the test above),
  // so a repeat, an unknown id and `__proto__` change nothing at all — the
  // result is every id in DETAIL_CARDS order, `on` iff it is `calendar`.
  const expected = DETAIL_CARDS.map((id) => ({ id, on: id === 'calendar' }));
  assert.deepEqual(parseCardList(['calendar', 'calendar', 'nonsense', '__proto__']), expected,
    'a repeated, unknown or prototype id must not change the legacy result');
  assert.equal(/** @type {any} */ ({}).polluted, undefined);

  // New (object) form: the FIRST occurrence wins, so its `on` survives.
  const dupedNew = [
    { id: 'calendar', on: false },
    { id: 'calendar', on: true },
    { id: 'nonsense', on: true },
    { id: '__proto__', on: true },
  ];
  const result = parseCardList(dupedNew);
  assert.deepEqual(result.find((c) => c.id === 'calendar'), { id: 'calendar', on: false },
    'the first entry for a repeated id must win, not the last');
  assert.equal(result.some((c) => c.id === 'nonsense' || c.id === '__proto__'), false);
  assert.equal(result.length, DETAIL_CARDS.length,
    'unknown ids must be dropped rather than counted toward the nine');

  // Neither shape: some elements are strings and some are objects. No
  // legitimate client produces this, and guessing which rule applies is the
  // ambiguity the object shape was chosen to avoid.
  assert.equal(parseCardList(['calendar', { id: 'history', on: true }]), undefined);
});

test('anything that is not a list of cards is refused outright', () => {
  for (const bad of ['calendar', 42, null, undefined, {}]) {
    assert.equal(parseCardList(/** @type {any} */ (bad)), undefined,
      `accepted ${JSON.stringify(bad)}`);
  }
  // Obvious junk: a list far longer than there are cards is not a mistake.
  assert.equal(parseCardList(new Array(200).fill('calendar')), undefined);
});

test('the client and server card normalisers agree, over the same examples', () => {
  // Both suites pinned to the SAME inputs, for the reason the root CLAUDE.md
  // gives for every offline client mirror: two readers of one rule must not
  // be free to answer differently. `shared/src` is not served to the browser,
  // so `SETTINGS.detailCards.normalise` cannot simply call `parseCardList` —
  // it is a second implementation, and this is what keeps the two honest.
  const examples = [
    ['history', 'calendar'],
    [],
    [...DETAIL_CARDS].reverse(),
    DETAIL_CARDS.map((id) => ({ id, on: true })),
    DETAIL_CARDS.filter((id) => id !== 'awards').map((id) => ({ id, on: false })),
    ['calendar', 'calendar', 'nonsense', '__proto__'],
    ['calendar', { id: 'history', on: true }],
    'calendar',
    // Pins the COERCION rule for `on` in a new-shape list: both sides do
    // `!!e.on`. Every example above uses a literal `true`/`false`, so none of
    // them would notice a mirror that instead did `e.on === true`.
    [
      { id: 'strength', on: 1 },
      // Not first, and truthy-but-not-`true`, so this example also fails a
      // mirror that special-cases the card with no canonical predecessor.
      { id: 'recentDays', on: 'x' },
      { id: 'calendar', on: 0 },
      { id: 'streaks', on: 'yes' },
      { id: 'resilience', on: null },
      { id: 'awards', on: undefined },
      { id: 'history', on: true },
      { id: 'weekdays', on: false },
      { id: 'weekdayMonths', on: 1 },
      { id: 'frequency', on: 0 },
    ],
    // Pins first-wins for a DUPLICATE id in NEW-SHAPE form. The table's only
    // duplicate example above is legacy strings; first-wins for objects is
    // otherwise asserted against parseCardList alone, so a mirror that deduped
    // last-wins would pass every other example here.
    [{ id: 'calendar', on: false }, { id: 'calendar', on: true }],
    // Pins the JUNK CAP through parity. The two sides compute it from
    // different sources — the server from `DETAIL_CARDS.length * 4`, the
    // browser from `SETTINGS.detailCards.options.length * 4` — and this
    // input is otherwise checked against parseCardList alone.
    new Array(200).fill('calendar'),
    // Pins non-array SCALARS other than a string: `null` is refused outright,
    // and `{}` — not an array — must be refused too, not treated as one entry.
    null,
    {},
  ];
  for (const example of examples) {
    assert.deepEqual(
      SETTINGS.detailCards.normalise(example), parseCardList(example),
      `client and server disagree on ${JSON.stringify(example)}`
    );
  }
});

test('the default order encodes its three arguments', () => {
  // Named in the assertion message, so reordering the builders table in
  // ui/detail.js (step 2) cannot silently move the default order in step 1's
  // registry without a test noticing.
  const order = DETAIL_CARDS;
  assert.equal(order[0], 'recentDays',
    'the one card you ACT on rather than read comes first — a reminder brings '
    + 'you here to answer, not to read');
  assert.equal(order[order.indexOf('strength') + 1], 'calendar',
    'calendar must sit directly under the score — immediately after strength');
  assert.equal(order[order.indexOf('resilience') + 1], 'awards',
    'a probability you can act on must beat a trophy — awards right after resilience');
});

test('the registry default is written in DETAIL_CARDS order', () => {
  // Before this change, this needed no test of its own: `parseCardList`
  // re-sorted anything it was handed into DETAIL_CARDS order, so a registry
  // default written in some other order failed "every registry default is a
  // value the SERVER accepts" the moment the two disagreed — the server's
  // reply would not deep-equal what was sent. Now a new-shape list is kept
  // verbatim, so that same test passes whatever order `default` is written
  // in, and nothing else pins the order against DETAIL_CARDS: the "every id
  // the dialog offers is one the page can actually draw" test above compares
  // `options`, not `default`, and "the default order encodes its two
  // arguments" reads DETAIL_CARDS itself, not the registry. This is what
  // makes that adjacency test mean anything about what a fresh account
  // actually gets — without this, DETAIL_CARDS and the shipped default are
  // free to drift apart with every other assertion in this file still green.
  assert.deepEqual(SETTINGS.detailCards.default.map((e) => e.id), [...DETAIL_CARDS],
    'the registry default has drifted from DETAIL_CARDS order — the adjacency ' +
    'test above only pins DETAIL_CARDS itself, so this is what actually connects ' +
    'it to what a fresh account is shipped');
});

test('every id the dialog offers is one the page can actually draw', () => {
  // The registry in ui/settings.js is a second copy of DETAIL_CARDS, because
  // shared/src is not served to the browser — the same shape CHANNELS has. The
  // key-parity test above cannot see this: it checks that `detailCards` exists
  // on both sides, not that the nine ids agree.
  const ui = readFileSync(join(root, 'public', 'ui', 'settings.js'), 'utf8');
  const block = uiSettingBlocks(ui).get('detailCards');
  assert.ok(block, 'detailCards is not in the registry at all');

  const offered = [...block.matchAll(/\{ value: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(offered, [...DETAIL_CARDS],
    'the dialog and the server disagree about which cards exist, or about their order');
});

test('every id the detail page can draw is one DETAIL_CARDS names, and no other', () => {
  // A THIRD copy of the nine ids, for the reason ui/detail.js's own comment on
  // `CARDS` gives: `shared/src` is not served to the browser, so the page that
  // actually builds a card cannot import `DETAIL_CARDS` either. This is a
  // source-text guard, not a behavioural one — it pins the SET of keys `CARDS`
  // is built from, nothing about what `render` draws or in what order. Order
  // is deliberately not asked here: `render` draws in whatever order the
  // STORED list names, not `CARDS`'s own declaration order, so pinning this
  // Map's order would be pinning an accident of source layout rather than a
  // rule. What DOES matter, and what a silent typo here would break, is that
  // every id `parseCardList` can hand the page is one `CARDS.get` can find —
  // `CARDS.get(id)?.forget?.()` in `forgetHiddenPositions` already tolerates a
  // miss by returning `undefined`, so a misspelled key would not throw, it
  // would just quietly stop drawing that card.
  const src = readFileSync(join(root, 'public', 'ui', 'detail.js'), 'utf8');
  const mapBody = src.slice(
    src.indexOf('const CARDS = new Map(['),
    src.indexOf(']);', src.indexOf('const CARDS = new Map(['))
  );
  const keys = [...mapBody.matchAll(/^\s*\['([^']+)',/gm)].map((m) => m[1]);
  assert.deepEqual(new Set(keys), new Set(DETAIL_CARDS),
    'ui/detail.js\'s CARDS Map and DETAIL_CARDS disagree about which cards exist');
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

test('groupByCategory defaults to false', () => {
  // Asserted as a literal rather than by importing some other constant that
  // could be wrong the same way: a fresh account has no categories, and a
  // grouped list with one section (Uncategorised, holding everything) is
  // strictly worse than the flat list it would replace.
  assert.equal(SETTINGS.groupByCategory.default, false);
  assert.deepEqual(parseSettings({ groupByCategory: true }).accepted,
    { groupByCategory: true });
  assert.deepEqual(parseSettings({ groupByCategory: 'yes' }).accepted, {});
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
const CONTROL_TYPES = ['select', 'toggle', 'multi', 'ordered-multi', 'text'];

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
    if (def.type === 'select' || def.type === 'multi' || def.type === 'ordered-multi') {
      // ...and it must HAVE one, or the check above could be dodged by
      // deleting the list rather than by fixing the default. `renderSettingsBody`
      // dereferences `def.options` for all three types anyway, so a missing
      // list is a dialog that throws.
      assert.ok(Array.isArray(def.options),
        `${key}: a ${def.type} with no options — the dialog cannot render it`);
    }

    if (Array.isArray(def.options)) {
      // ...and the other way round, which closes the way OUT of the check
      // above: retype a `select` as `text` and leave its options in place and
      // the membership rule below still runs, but the control renders as a free
      // text box and `isValid` degrades to "any string". Options mean one
      // thing, and the dialog reads them for three types.
      assert.ok(def.type === 'select' || def.type === 'multi' || def.type === 'ordered-multi',
        `${key}: a ${def.type} carrying options — only a select, a multi or an `
        + 'ordered-multi is rendered from a list');

      const offers = (v) => def.options.some((o) => o.value === v);
      if (def.type === 'multi') {
        assert.ok(Array.isArray(value) && value.every(offers),
          `${key}: the default ${JSON.stringify(value)} is not a subset of its options`);
      } else if (def.type === 'ordered-multi') {
        // Each entry is `{id, on}`, so membership is asked of `v.id` rather
        // than of the entry itself.
        assert.ok(Array.isArray(value) && value.every((v) => offers(v.id)),
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
      assert.ok(['select', 'multi', 'toggle', 'ordered-multi'].includes(def.type),
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
