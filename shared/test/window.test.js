import test from 'node:test';
import assert from 'node:assert/strict';

import {
  columnsForWidth, windowSlice, MIN_SLOT,
} from '../public/ui/window.js';

/* ---------- capacity ---------- */

test('capacity scales with the width given', () => {
  const narrow = columnsForWidth(360, 'bar');
  const wide = columnsForWidth(1200, 'bar');
  assert.ok(wide > narrow, `${wide} should exceed ${narrow}`);
});

test('denser marks fit more columns than sparser ones', () => {
  const w = 1000;
  assert.ok(columnsForWidth(w, 'point') > columnsForWidth(w, 'bar'));
  assert.ok(columnsForWidth(w, 'bar') > columnsForWidth(w, 'circle'));
});

test('capacity is never zero, however cramped', () => {
  // A zero-column chart would render nothing at all, which is worse than a
  // single cramped column.
  for (const w of [0, -100, 10, NaN, undefined]) {
    assert.ok(columnsForWidth(w, 'bar') >= 1, `width ${w} gave a bad capacity`);
  }
});

test('an explicit pixel figure overrides the named densities', () => {
  assert.equal(columnsForWidth(446, 100, 46), 4);
});

test('an unknown density name falls back rather than throwing', () => {
  assert.equal(columnsForWidth(500, 'nonsense'), columnsForWidth(500, 'bar'));
  // BUCKETERS-style prototype trap: '__proto__' is truthy on a plain lookup.
  assert.equal(columnsForWidth(500, '__proto__'), columnsForWidth(500, 'bar'));
});

/* ---------- windowing ---------- */

const items = Array.from({ length: 100 }, (_, i) => i);

test('the default window is the most recent data', () => {
  const w = windowSlice(items, 10, 0);
  assert.deepEqual(w.slice, [90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  assert.equal(w.canGoLater, false, 'already at the latest');
  assert.equal(w.canGoEarlier, true);
});

test('a positive offset scrolls into the past', () => {
  const w = windowSlice(items, 10, 20);
  assert.deepEqual(w.slice[0], 70);
  assert.deepEqual(w.slice.at(-1), 79);
  assert.ok(w.canGoLater && w.canGoEarlier);
});

test('paging past the start clamps instead of emptying the chart', () => {
  const w = windowSlice(items, 10, 9999);
  assert.equal(w.slice.length, 10);
  assert.deepEqual(w.slice[0], 0, 'clamped to the oldest data');
  assert.equal(w.canGoEarlier, false);
  assert.equal(w.offset, 90, 'the clamped offset is reported back');
});

test('a negative offset clamps to the latest window', () => {
  const w = windowSlice(items, 10, -50);
  assert.deepEqual(w.slice.at(-1), 99);
  assert.equal(w.offset, 0);
});

test('data that already fits needs no paging', () => {
  const w = windowSlice([1, 2, 3], 10, 0);
  assert.deepEqual(w.slice, [1, 2, 3]);
  assert.equal(w.canGoEarlier, false);
  assert.equal(w.canGoLater, false);
});

test('an empty series does not blow up', () => {
  const w = windowSlice([], 10, 0);
  assert.deepEqual(w.slice, []);
  assert.equal(w.canGoEarlier, false);
  assert.equal(w.canGoLater, false);
});

test('the window never exceeds the data length', () => {
  for (const n of [0, 1, 5, 100]) {
    const w = windowSlice(items.slice(0, n), 10, 0);
    assert.ok(w.slice.length <= n, `${w.slice.length} > ${n}`);
  }
});

test('paging back then forward returns to where it started', () => {
  // The controls page by slice length minus one, so this mirrors what the
  // Earlier/Later buttons actually do.
  const first = windowSlice(items, 10, 0);
  const stride = first.slice.length - 1;

  const back = windowSlice(items, 10, first.offset + stride);
  const forward = windowSlice(items, 10, back.offset - stride);

  assert.deepEqual(forward.slice, first.slice);
});

test('every column is reachable by paging', () => {
  // Nothing should be strandable between windows — a stride larger than the
  // window would skip data silently.
  const capacity = 10;
  const stride = capacity - 1;
  const seen = new Set();

  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const w = windowSlice(items, capacity, offset);
    w.slice.forEach((v) => seen.add(v));
    if (!w.canGoEarlier) break;
    offset = w.offset + stride;
  }

  assert.equal(seen.size, items.length,
    `${items.length - seen.size} columns are unreachable`);
});

/* ---------- the two working together ---------- */

test('a real card width produces a usable window', () => {
  // ~1026px is the measured inner width of a card on a 1440px desktop.
  const capacity = columnsForWidth(1026, 'bar');
  const w = windowSlice(items, capacity, 0);

  assert.ok(w.slice.length > 10, `only ${w.slice.length} columns on a desktop`);
  assert.ok(w.slice.length <= items.length);
  assert.ok(MIN_SLOT.bar * w.slice.length <= 1026,
    'the columns should fit in the width they were sized for');
});
