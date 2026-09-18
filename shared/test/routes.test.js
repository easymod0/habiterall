import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, LIST, current, go, hashFor, init, parseRoute } from '../public/ui/routes.js';

/* ---------- parsing ---------- */

test('a habit fragment names that habit', () => {
  assert.deepEqual(parseRoute('#/habit/42'), { view: 'habit', id: 42 });
  // The leading '#' is optional: `location.hash` carries it, a stored route
  // may not, and both are the same route.
  assert.deepEqual(parseRoute('/habit/42'), { view: 'habit', id: 42 });
});

test('no fragment is the dashboard', () => {
  assert.deepEqual(parseRoute(''), LIST);
  assert.deepEqual(parseRoute('#'), LIST);
  assert.deepEqual(parseRoute(undefined), LIST);
});

test('the comparison fragment names the comparison', () => {
  assert.deepEqual(parseRoute('#/categories'), { view: 'categories' });
  assert.deepEqual(parseRoute('/categories'), { view: 'categories' });
  assert.deepEqual(parseRoute(' #/categories '), { view: 'categories' });
});

test('a near miss at the comparison is the dashboard', () => {
  // Anchored at both ends, like HABIT_RE: the comparison is one page over the
  // whole account, so anything after it names nothing.
  for (const hash of [
    '#/categories/',
    '#/categories/4',
    '#/category',
    '#/CATEGORIES',
    '#categories',
  ]) {
    assert.deepEqual(parseRoute(hash), LIST, hash);
  }
});

test("a category fragment names that category's own page", () => {
  assert.deepEqual(parseRoute('#/category/3'), { view: 'category', id: 3 });
  assert.deepEqual(parseRoute('/category/3'), { view: 'category', id: 3 });
  assert.deepEqual(parseRoute(' #/category/3 '), { view: 'category', id: 3 });
});

test('a near miss at a category page is the dashboard', () => {
  // Anchored at both ends and digits only, like HABIT_RE: the fragment arrives
  // from a bookmark or a typed URL, so anything that is not exactly an id
  // names nothing.
  for (const hash of [
    '#/category/3x',      // trailing junk
    '#/category/3/',      // a route that does not exist
    '#/category/',        // no id
    '#/category',         // no id at all
    '#/category/-1',      // negative
    '#/category/1.5',     // not an integer
    '#/category/0',       // not an id
    '#/CATEGORY/3',       // wrong case
    '#/category/3?x',     // a query on a fragment
  ]) {
    assert.deepEqual(parseRoute(hash), LIST, hash);
  }
});

test('a category id too large to be an id is refused', () => {
  // `\d+` will happily match 30 digits, and Number() turns those into a float
  // that would be sent to the server as an id — the same bound the habit arm
  // carries, stated again because a second arm does not inherit the first's.
  assert.deepEqual(parseRoute('#/category/' + '9'.repeat(30)), LIST);
});

test('the comparison and a category page do not cross-talk', () => {
  // One is plural and carries no id, the other is singular and carries one.
  // The order they are tested in is stable, and neither may answer for the
  // other: `#/categories` opening one category's page would be a page over
  // the wrong set of habits.
  assert.deepEqual(parseRoute('#/categories'), CATEGORIES);
  assert.deepEqual(parseRoute('#/category/3'), { view: 'category', id: 3 });
  assert.notDeepEqual(parseRoute('#/category/3'), CATEGORIES);
});

test('anything unrecognised is the dashboard, never an error', () => {
  // A URL is typed, pasted and truncated by chat clients. Every one of these
  // has to land somewhere useful rather than throw on the way to first paint.
  for (const hash of [
    '#/habits/42',        // plural
    '#/habit/',           // no id
    '#/habit/abc',        // not a number
    '#/habit/-1',         // negative
    '#/habit/1.5',        // not an integer
    '#/habit/42/edit',    // a route that does not exist
    '#habit/42',          // missing the slash
    '#/HABIT/42',         // wrong case
    'javascript:alert(1)',
  ]) {
    assert.deepEqual(parseRoute(hash), LIST, hash);
  }
});

test('surrounding whitespace is not a different route', () => {
  // A pasted link picks up a trailing space more often than it does not.
  assert.deepEqual(parseRoute(' #/habit/42 '), { view: 'habit', id: 42 });
});

test('an id too large to be an id is refused', () => {
  // `\d+` will happily match 30 digits, and Number() turns those into a float
  // that would be sent to the server as an id.
  assert.deepEqual(parseRoute('#/habit/999999999999999999999999'), LIST);
  assert.deepEqual(parseRoute('#/habit/0'), LIST);
});

/* ---------- formatting ---------- */

test('a route and its fragment round trip', () => {
  for (const id of [1, 42, 9007199254740991]) {
    const route = { view: 'habit', id };
    assert.deepEqual(parseRoute(hashFor(route)), route);
  }
});

test('the dashboard has no fragment', () => {
  // Not '#': a bare hash survives a copy-paste looking like a mistake.
  assert.equal(hashFor(LIST), '');
  assert.equal(hashFor(undefined), '');
});

test('the comparison route and its fragment round trip', () => {
  // The literal, not `hashFor(CATEGORIES)` fed back to itself: a round trip
  // through two functions that agree with each other pins neither spelling.
  assert.equal(hashFor(CATEGORIES), '#/categories');
  assert.deepEqual(parseRoute('#/categories'), CATEGORIES);
});

test("a category page's route and its fragment round trip", () => {
  // The literal again, and singular: `#/categories` is a different page, and
  // a round trip through two functions that agree with each other would not
  // notice one spelling the other's.
  assert.equal(hashFor({ view: 'category', id: 3 }), '#/category/3');
  assert.deepEqual(parseRoute('#/category/3'), { view: 'category', id: 3 });
});

/* ---------- writing the URL ---------- */

/**
 * A fake `location`/`history`/`window` that records what was done to it.
 *
 * `init` is called on the way out so each test starts from "nothing showing is
 * ours" — the module tracks that across calls, and without the reset these
 * tests would pass or fail depending on the order they ran in.
 *
 * @returns {{calls: any[], fire: () => void, listeners: string[]}}
 */
function fakeUrl(hash = '', onRoute = () => {}) {
  const calls = [];
  const listeners = [];
  const handlers = [];
  globalThis.location = { hash, pathname: '/', search: '' };
  globalThis.history = {
    pushState: (_s, _t, url) => { calls.push(['push', url]); globalThis.location.hash = url; },
    replaceState: (_s, _t, url) => { calls.push(['replace', url]); globalThis.location.hash = ''; },
    back: () => { calls.push(['back']); },
  };
  globalThis.window = {
    addEventListener: (type, fn) => { listeners.push(type); handlers.push(fn); },
  };
  init(onRoute);
  return { calls, listeners, fire: () => { for (const h of handlers) h(); } };
}

test('opening a habit pushes, so Back leaves it', () => {
  const { calls } = fakeUrl('');
  go({ view: 'habit', id: 7 });
  assert.deepEqual(calls, [['push', '#/habit/7']]);
});

test('returning to the list unwinds the push rather than writing over it', () => {
  // Overwriting left the entry in place with the list's URL, so Back landed on
  // a second copy of the list and appeared to do nothing — once per habit ever
  // opened.
  const { calls } = fakeUrl('');
  go({ view: 'habit', id: 7 });
  go(LIST);
  assert.deepEqual(calls, [['push', '#/habit/7'], ['back']]);
});

test('the list replaces when there is nothing of ours to unwind', () => {
  // A cold load straight onto a habit: that entry is the first in the session,
  // so going back from it would leave the site.
  const { calls } = fakeUrl('#/habit/7');
  go(LIST);
  assert.deepEqual(calls, [['replace', '/']]);
});

test('one Back press does the work once, not twice', () => {
  // popstate and hashchange both fire for a single fragment traversal in
  // Chrome (measured). Acting on both ran two dashboard loads — four requests
  // — for one press.
  const seen = [];
  const { fire, listeners } = fakeUrl('', (route) => seen.push(route));
  assert.deepEqual(listeners, ['hashchange', 'popstate']);

  globalThis.location.hash = '#/habit/9';   // the browser has traversed
  fire();                                   // both listeners run

  assert.equal(seen.length, 1, 'route change handled once');
  assert.deepEqual(seen[0], { view: 'habit', id: 9 });
});

test('a traversal to a habit leaves that entry unwindable', () => {
  // Forward onto a habit is as much "our" entry as opening it was, or the
  // duplicate-list bug comes back through the Forward button.
  const { calls, fire } = fakeUrl('');
  globalThis.location.hash = '#/habit/9';
  fire();
  go(LIST);
  assert.deepEqual(calls, [['back']]);
});

test('a route already showing writes nothing', () => {
  // The detail view re-enters `open()` for every zoom, page and granularity
  // control. Without this each of those would be a history entry, and Back
  // would walk through a dozen redraws of one habit before leaving it.
  const { calls } = fakeUrl('#/habit/7');
  go({ view: 'habit', id: 7 });
  go({ view: 'habit', id: 7 });
  assert.deepEqual(calls, []);

  const list = fakeUrl('');
  go(LIST);
  assert.deepEqual(list.calls, []);
});

test('opening the comparison from the dashboard pushes one entry', () => {
  const { calls } = fakeUrl('');
  go(CATEGORIES);
  assert.deepEqual(calls, [['push', '#/categories']]);

  // ...and Back from it unwinds that one push, exactly as a habit's does.
  go(LIST);
  assert.deepEqual(calls, [['push', '#/categories'], ['back']]);
});

test('the comparison is PUSHED, never written over the entry showing', () => {
  // Replacing looks like the tidier way to keep the stack one deep, and it is
  // the wrong one: a same-document open counts an entry in
  // `WebBackStack.floorAfterShow`, so a habit opened from a notification sets
  // the floor at that entry — replace, and `currentIndex` stays AT the floor
  // and the next system Back closes the screen instead of reaching the
  // dashboard. What keeps the stack one deep is the button being absent while
  // a habit is open (`syncEntry` in ui/categories.js), not what this writes.
  const { calls } = fakeUrl('');
  go(CATEGORIES);
  assert.deepEqual(calls, [['push', '#/categories']],
    'a push, so Back has an entry of its own to leave through');
  assert.equal(calls.filter(([kind]) => kind === 'replace').length, 0);
});

test('a traversal onto the comparison leaves that entry unwindable', () => {
  // Forward onto it is as much "our" entry as opening it was — the same rule
  // the habit above has, and dropping it brings the duplicate-list bug back
  // through the Forward button.
  const { calls, fire } = fakeUrl('');
  globalThis.location.hash = '#/categories';
  fire();
  go(LIST);
  assert.deepEqual(calls, [['back']]);
});

test("opening a category's own page from the dashboard pushes one entry", () => {
  const { calls } = fakeUrl('');
  go({ view: 'category', id: 3 });
  assert.deepEqual(calls, [['push', '#/category/3']],
    'a push, so Back has an entry of its own to leave through');
  assert.equal(calls.filter(([kind]) => kind === 'replace').length, 0);

  // ...and returning to the list unwinds that one push rather than writing
  // over it, exactly as a habit's and the comparison's do. Replacing is the
  // tidy-looking wrong answer: a same-document open counts an entry in
  // `WebBackStack.floorAfterShow`, so it leaves `currentIndex` AT the floor
  // and the next system Back closes the screen instead of reaching the
  // dashboard.
  go(LIST);
  assert.deepEqual(calls, [['push', '#/category/3'], ['back']]);
});

test("a traversal onto a category's own page leaves that entry unwindable", () => {
  // Forward onto it is as much "our" entry as opening it was — `init` asks
  // "does this route have a fragment", so a third fragment route needed
  // nothing there, and this is what says so.
  const { calls, fire } = fakeUrl('');
  globalThis.location.hash = '#/category/3';
  fire();
  go(LIST);
  assert.deepEqual(calls, [['back']]);
});

test('current() reads the address bar', () => {
  fakeUrl('#/habit/3');
  assert.deepEqual(current(), { view: 'habit', id: 3 });
});
