import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, isQueryActive, state } from '../public/ui/store.js';

// `store.js` is a browser module but imports nothing and touches no DOM, so it
// loads as-is in node. The point of this file is the one invariant the
// dashboard's "filter live" flag depends on: `isQueryActive` and `matchesQuery`
// must agree on what an empty query is. A bare `!!query.trim()` and the
// fold-based matcher did not — a query of only combining accents is empty to
// the matcher (it matches everything) but non-empty to `.trim()`, so the
// indicator lit for a filter that was doing nothing (#180).

test('isQueryActive is false for the empty string', () => {
  assert.equal(isQueryActive(''), false);
});

test('isQueryActive is false for only whitespace', () => {
  assert.equal(isQueryActive('   '), false);
});

test('isQueryActive is false for only combining marks', () => {
  // U+0300 combining grave accent — `.trim()` leaves it, fold+trim strips it.
  assert.equal(isQueryActive('̀'), false);
  assert.equal(isQueryActive('̀́̂'), false);
});

test('isQueryActive is true for a real word', () => {
  assert.equal(isQueryActive('gym'), true);
});

test('isQueryActive treats an accented word as live (the accent folds away)', () => {
  assert.equal(isQueryActive('Café'), true);
});

test('isQueryActive defaults to the live state.query', () => {
  const saved = state.query;
  state.query = '̀';
  try {
    assert.equal(isQueryActive(), false);
    state.query = 'gym';
    assert.equal(isQueryActive(), true);
  } finally {
    state.query = saved;
  }
});

test('matchesQuery matches everything when isQueryActive is false', () => {
  const anything = { name: 'Whatever', description: 'anything' };
  for (const empty of ['', '   ', '̀', '̀́']) {
    assert.equal(isQueryActive(empty), false,
      `expected "${empty}" to be inactive`);
    assert.equal(matchesQuery(anything, empty), true,
      `expected matchesQuery to treat "${empty}" as no filter`);
  }
});

test('matchesQuery and isQueryActive agree on a combining-mark-only query', () => {
  // The exact regression from #180: the dashboard lit the indicator while the
  // matcher matched everything. The two must now read the same query the same
  // way — either both live (filter narrows the list) or both not (no filter).
  const q = '̀';
  assert.equal(isQueryActive(q), false,
    'combining-mark-only query is not active');
  assert.equal(matchesQuery({ name: 'does-not-contain-the-folded-q' }, q), true,
    'combining-mark-only query matches everything, i.e. is no filter');
});

test('a live query narrows the list the same way for both', () => {
  const q = 'gym';
  assert.equal(isQueryActive(q), true);
  assert.equal(matchesQuery({ name: 'Gym' }, q), true);
  assert.equal(matchesQuery({ name: 'Read' }, q), false);
});