import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { state } from '../public/ui/store.js';

// What a REFUSED refetch of a category's own page means, and the one
// distinction the 'change' listener turns on: `openCategory` answers `false`
// for two different facts, and only one of them is fatal to the page. The
// category is GONE — a good reply with no such section, which nothing can undo
// — or the REQUEST failed, which says nothing about whether the category still
// exists. Going home on the first is the recovery `app.js`'s boot already
// performs for it; going home on the second throws a reader off a page that is
// still true, and offline that is every refetch.
//
// `ui/categories.js` reaches `document` at module load, so the two functions
// are SLICED OUT and run with stubs bound to the names they close over —
// exactly as `test/browser/daydialog.mjs` replays `openDayDialog`. That keeps
// this behavioural rather than a source-text guard: the real bodies run, so an
// inverted comparison or a dropped assignment fails it. What it cannot see is
// the wiring around them (that `init` registers this listener at all, that the
// dashboard answers 'reload'), which is `categorycheck.mjs`'s and
// `routecheck.mjs`'s half in a real browser.
//
// `state` is the REAL store object, because `openCategoryId` is the field the
// whole argument is about and a stub would pin a field of this file's own
// invention. `emit`, `toast`, `api`, `open` and `renderOne` are stubs: each is
// something this test has to observe or decide.

const src = readFileSync(
  fileURLToPath(new URL('../public/ui/categories.js', import.meta.url)), 'utf8');

/** One slice, or a loud failure — a boundary that has moved must not read as a pass. */
function slice(from, to, after = 0) {
  const start = src.indexOf(from);
  assert.notEqual(start, -1, `ui/categories.js no longer contains ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start);
  assert.notEqual(end, -1, `no ${JSON.stringify(to)} after ${JSON.stringify(from)}`);
  return src.slice(start, end + after);
}

// The function, with `export` dropped — a module-only keyword, and this body is
// compiled as one.
const openCategorySrc = slice('export async function openCategory(id) {', '\n}\n', 2)
  .replace('export async function', 'async function');

// The listener's arrow function, taken from `init()` where it is registered.
const listenerSrc = slice('async () => {\n    if (state.openCategories)', '\n  });', 4);

/**
 * Both, in one closure, so they share the module-level `openSeq` the real ones
 * share. Anything either body reads is handed in; a free identifier this misses
 * is a ReferenceError rather than a silent pass.
 */
const build = new Function('deps', `
  const { api, toast, renderOne, state, emit, open, GRANULARITY } = deps;
  let openSeq = 0;
  ${openCategorySrc}
  const onChange = ${listenerSrc};
  return { openCategory, onChange };
`);

/** @param {{reply?: any, fail?: Error}} how  what the one request does */
function harness(how) {
  const seen = { toasts: [], emits: [], rendered: [], opened: 0, requests: 0 };
  const parts = build({
    GRANULARITY: 'week',
    state,
    api: async () => {
      seen.requests++;
      if (how.fail) throw how.fail;
      return how.reply;
    },
    toast: (m) => seen.toasts.push(m),
    emit: (e) => seen.emits.push(e),
    open: () => { seen.opened++; },
    renderOne: (section) => seen.rendered.push(section.id),
  });
  return { ...parts, seen };
}

const reply = (...ids) => ({ categories: ids.map((id) => ({ id, name: `c${id}`, roster: [] })) });

/** The three flags, restored around each case: this test writes the real store. */
async function withState(open, id, fn) {
  const before = {
    cats: state.openCategories, one: state.openCategoryId, habit: state.openHabitId,
  };
  state.openCategories = open;
  state.openCategoryId = id;
  state.openHabitId = null;
  try {
    return await fn();
  } finally {
    state.openCategories = before.cats;
    state.openCategoryId = before.one;
    state.openHabitId = before.habit;
  }
}

test('a refetch that finds the category gone drops the id and goes home', async () => {
  const h = harness({ reply: reply(9) });          // every category but this one
  await withState(false, 3, async () => {
    await h.onChange();
    // The id first, because it is what the listener asks and what keeps
    // `#/category/3` from staying live over a page that can never be drawn.
    assert.equal(state.openCategoryId, null, 'a dead id must not be held');
    assert.deepEqual(h.seen.emits, ['reload'], 'the dashboard takes over');
    assert.equal(h.seen.rendered.length, 0);
    assert.match(h.seen.toasts[0] ?? '', /no longer exists/);
  });
});

test('a refetch whose REQUEST fails keeps the id and the page', async () => {
  // Offline, a 500, a timeout: the answer never came, so nothing here has
  // learnt that the category is gone — and the page on screen is still true.
  // This is the case round 1 widened by reloading on the boolean alone.
  const h = harness({ fail: new Error('Saved offline.') });
  await withState(false, 3, async () => {
    await h.onChange();
    assert.equal(state.openCategoryId, 3, 'the page stays open');
    assert.deepEqual(h.seen.emits, [], 'no bounce to the dashboard');
    assert.deepEqual(h.seen.toasts, ['Saved offline.'],
      'the request speaks for itself, in its own words');
  });
});

test('a refetch that finds the category redraws it and says nothing', async () => {
  const h = harness({ reply: reply(3, 9) });
  await withState(false, 3, async () => {
    await h.onChange();
    assert.deepEqual(h.seen.rendered, [3]);
    assert.equal(state.openCategoryId, 3);
    assert.deepEqual(h.seen.emits, []);
    assert.deepEqual(h.seen.toasts, []);
  });
});

test('the comparison is the other view, and it is refetched instead', async () => {
  // The flags are mutually exclusive, so this branch must not reach
  // `openCategory` at all — and must not reload, whatever `open()` answers.
  const h = harness({ fail: new Error('nope') });
  await withState(true, null, async () => {
    await h.onChange();
    assert.equal(h.seen.opened, 1);
    assert.equal(h.seen.requests, 0);
    assert.deepEqual(h.seen.emits, []);
  });
});

test('neither view open is nothing to refetch', async () => {
  const h = harness({ reply: reply(3) });
  await withState(false, null, async () => {
    await h.onChange();
    assert.equal(h.seen.requests, 0);
    assert.equal(h.seen.opened, 0);
    assert.deepEqual(h.seen.emits, []);
  });
});

test('a superseded reply is discarded, and discarding is not refusing', async () => {
  // `openSeq`'s own case, asked here because this harness is where the two
  // functions share one counter: a second call takes the newer ticket, so the
  // first answers `true` — not `false`, which would send `app.js`'s boot to
  // the dashboard over a page something newer is about to draw — and paints
  // nothing.
  const h = harness({ reply: reply(3, 9) });
  await withState(false, 3, async () => {
    const first = h.openCategory(3);
    const second = h.openCategory(9);
    assert.equal(await first, true, 'a discard is not a refusal');
    assert.equal(await second, true);
    assert.deepEqual(h.seen.rendered, [9], 'only the newest reply may paint');
  });
});
