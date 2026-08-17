import test from 'node:test';
import assert from 'node:assert/strict';

import {
  columnsForWidth, gridColumns, windowSlice,
  GRID_DAYS, GRID_DAYS_MEDIUM, GRID_DAYS_NARROW, MIN_SLOT,
} from '../public/ui/window.js';
import { SETTING_VALUES } from '../src/validate.js';

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

/* ---------- the dashboard's day columns ---------- */

/** Widths either side of each ladder step, plus the four the suites emulate. */
const WIDTHS = [320, 360, 390, 640, 641, 768, 900, 901, 1024, 1100, 1440, 2560];

/** What the grid drew before `gridDays` existed, restated independently. */
const ladder = (w) =>
  (w <= 640 ? GRID_DAYS_NARROW : w <= 900 ? GRID_DAYS_MEDIUM : GRID_DAYS);

test('auto draws exactly what the grid drew before the setting existed', () => {
  // The default must move nobody's dashboard. Restated here rather than
  // imported, so a change to the ladder has to be made twice on purpose.
  for (const w of WIDTHS) {
    assert.equal(gridColumns('auto', w), ladder(w), `at ${w}px`);
  }
});

test('an absent or unrecognised value is auto, not a number', () => {
  // `GET /settings` returns only the keys that have been STORED, so almost
  // every account arrives here with nothing at all — and a stale value from an
  // older build must degrade to the ladder rather than to 0 columns or NaN.
  for (const bad of [undefined, null, '', 'thirty', 'auto', {}, [], -3, 0, 1.5]) {
    assert.equal(gridColumns(/** @type {any} */ (bad), 1440), GRID_DAYS,
      `${JSON.stringify(bad)} should fall back to the ladder`);
  }
});

test('the setting is a CAP: it never draws more than the width fits', () => {
  // The per-width ladder is the fix for a real layout bug — at 768px the
  // 14-column layout needed 668px of a 698px row and squeezed the habit name
  // to nothing. Drop the Math.min and this is back, on the device this app is
  // mostly used on.
  for (const w of WIDTHS) {
    for (const chosen of ['5', '7', '10', '14', '30', '365']) {
      assert.ok(gridColumns(chosen, w) <= ladder(w),
        `${chosen} at ${w}px drew ${gridColumns(chosen, w)}, over the ${ladder(w)} that fit`);
    }
  }
});

test('a phone asked for a fortnight still draws a week', () => {
  // The case above, named — this is the pass responsive.mjs makes in a real
  // browser, and the one an option list allowing MORE than 14 could not have.
  assert.equal(gridColumns('14', 390), GRID_DAYS_NARROW);
  assert.equal(gridColumns('14', 768), GRID_DAYS_MEDIUM);
  assert.equal(gridColumns('14', 1440), GRID_DAYS);
});

test('a choice below the ladder is honoured at every width', () => {
  // The other half, and the half the issue is actually about: someone with
  // four habits wanting five fat columns they can hit with a thumb. Ignore
  // `chosen` and this is the only test that notices.
  for (const w of WIDTHS) {
    assert.equal(gridColumns('5', w), 5, `at ${w}px`);
  }
});

test('every offered value is at most GRID_DAYS, which is what keeps /overview out of this', () => {
  // `load()` asks the server for GRID_DAYS days and nothing else — the widest
  // the grid can ever show — so changing the setting needs no refetch and no
  // route in either edition knows this exists. Offer a value above 14 and that
  // reasoning silently stops holding: the grid would page into days that were
  // never fetched and paint them as unrecorded.
  //
  // Read from SETTING_VALUES rather than restated, which is the whole point —
  // a restated list passes forever however the real one grows.
  for (const chosen of SETTING_VALUES.gridDays) {
    if (chosen === 'auto') continue;
    assert.ok(Number(chosen) <= GRID_DAYS,
      `"${chosen}" exceeds the ${GRID_DAYS}-day window load() fetches — either ` +
      'lower it, or teach load() to ask for more');
  }
});
