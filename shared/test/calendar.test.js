import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calendarWindow, zoomLevel, weeksForWidth, calendarWidth,
  CALENDAR_ZOOM, DEFAULT_ZOOM, CALENDAR_PAD_LEFT,
} from '../public/ui/calendar.js';

/** Every date the grid draws, in order. */
function cells(endDate, weeks) {
  const { start } = calendarWindow(endDate, weeks);
  const [y, m, d] = start.split('-').map(Number);
  const cursor = new Date(y, m - 1, d);
  const out = [];
  for (let i = 0; i < weeks * 7; i++) {
    out.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * The bug this file exists for: the grid was anchored on its start, so it
 * ended up to six days before `endDate` and today's square was only visible
 * when today happened to be a Saturday.
 */
test('the end date is always drawn, whatever weekday it falls on', () => {
  // A full week: Sunday 2026-08-09 through Saturday 2026-08-15.
  const week = [
    '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12',
    '2026-08-13', '2026-08-14', '2026-08-15',
  ];

  for (const day of week) {
    const drawn = cells(day, 27);
    assert.ok(
      drawn.includes(day),
      `${day} (weekday ${new Date(day + 'T00:00:00').getDay()}) is missing from the grid`
    );
  }
});

test('the grid always starts on a Sunday so the weekday rows line up', () => {
  for (const day of ['2026-08-09', '2026-08-12', '2026-08-15', '2026-01-01']) {
    for (const weeks of [14, 27, 53]) {
      const { start } = calendarWindow(day, weeks);
      assert.equal(
        new Date(start + 'T00:00:00').getDay(), 0,
        `${day} @ ${weeks}w started on a ${new Date(start + 'T00:00:00').getDay()}`
      );
    }
  }
});

test('the grid ends on the Saturday closing the end date\'s week', () => {
  // Wednesday -> that week's Saturday.
  assert.equal(calendarWindow('2026-08-12', 27).end, '2026-08-15');
  // A Saturday is already the end of its own week.
  assert.equal(calendarWindow('2026-08-15', 27).end, '2026-08-15');
  // A Sunday opens a new week, so the grid runs to the following Saturday.
  assert.equal(calendarWindow('2026-08-16', 27).end, '2026-08-22');
});

test('the window spans exactly the requested number of weeks', () => {
  for (const weeks of [14, 27, 53]) {
    const drawn = cells('2026-08-12', weeks);
    assert.equal(drawn.length, weeks * 7);

    const { start, end } = calendarWindow('2026-08-12', weeks);
    assert.equal(drawn[0], start);
    assert.equal(drawn.at(-1), end);
  }
});

test('a date in the future of the window is still the anchor', () => {
  // Paging back: endDate is in the past, and must still be the last real cell
  // in the grid rather than sitting mid-column.
  const drawn = cells('2026-03-04', 14);
  assert.ok(drawn.includes('2026-03-04'));
  assert.equal(calendarWindow('2026-03-04', 14).end, '2026-03-07');
});

test('the window crosses a year boundary correctly', () => {
  const drawn = cells('2026-01-01', 53);
  assert.ok(drawn.includes('2026-01-01'));
  assert.ok(drawn.includes('2025-12-31'));
  assert.equal(drawn.length, 53 * 7);
});

/* ---------- zoom ---------- */

test('every zoom level is usable', () => {
  for (const [name, level] of Object.entries(CALENDAR_ZOOM)) {
    assert.ok(level.cell > 0, `${name} has no cell size`);
    assert.ok(level.gap >= 0, `${name} has a negative gap`);
    assert.ok(level.weeks > 0, `${name} shows no weeks`);
  }
});

test('zooming in makes squares bigger and shows less history', () => {
  // The order the +/- buttons step through, closest first.
  const order = ['closest', 'close', 'default', 'wide'].map(zoomLevel);

  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1].cell > order[i].cell,
      `cells must shrink as you zoom out (step ${i})`);
    assert.ok(order[i - 1].weeks < order[i].weeks,
      `more history must fit as you zoom out (step ${i})`);
  }
});

test('the grid never overshoots the width it was given', () => {
  // One trailing gap of overshoot is enough for `max-width: 100%` to scale the
  // whole SVG down, so 13px cells render at 12.6px and look blurry.
  for (const zoom of Object.keys(CALENDAR_ZOOM)) {
    for (const width of [1026, 935, 679, 500, 332]) {
      const weeks = weeksForWidth(width, zoom);
      const drawn = calendarWidth(weeks, zoom);
      // Only assert fit where the level's minimum actually fits; a phone is
      // expected to overflow and scroll.
      if (weeks > CALENDAR_ZOOM[zoom].weeks) {
        assert.ok(drawn <= width,
          `${zoom} @ ${width}px drew ${drawn}px (${weeks} weeks)`);
      }
    }
  }
});

/* ---------- filling the available width ---------- */

test('the grid fills the width it is given', () => {
  // A 1026px card at default zoom: the calendar used to sit at 454px and
  // leave 572px of the card empty.
  const weeks = weeksForWidth(1026, 'default');
  const { cell, gap } = zoomLevel('default');
  const drawn = calendarWidth(weeks, 'default');

  assert.ok(drawn <= 1026, `overflowed: ${drawn}px in 1026px`);
  // Within one column of filling it.
  assert.ok(drawn > 1026 - (cell + gap), `left ${1026 - drawn}px unused`);
  assert.ok(weeks > CALENDAR_ZOOM.default.weeks, 'did not grow past the minimum');
});

test('a narrow screen still gets the zoom level\'s intended span', () => {
  // A phone cannot fit 27 columns at 13px, but the window must not silently
  // shrink to a fortnight — it scrolls instead.
  for (const zoom of Object.keys(CALENDAR_ZOOM)) {
    assert.equal(
      weeksForWidth(330, zoom), CALENDAR_ZOOM[zoom].weeks,
      `${zoom} shrank below its minimum on a narrow screen`
    );
  }
});

test('a very wide monitor is capped', () => {
  // Without a ceiling, an ultrawide would ask for many years of history and
  // the bounded date range would do a lot of pointless work.
  assert.equal(weeksForWidth(100_000, 'wide', 105), 105);
  assert.ok(weeksForWidth(5000, 'close') <= 105);
});

test('zooming in still shows less history at the same width', () => {
  // The relationship the +/- buttons promise must survive width-filling.
  const width = 1026;
  const close = weeksForWidth(width, 'close');
  const def = weeksForWidth(width, 'default');
  const wide = weeksForWidth(width, 'wide');

  assert.ok(close < def, `close ${close} should be under default ${def}`);
  assert.ok(def < wide, `default ${def} should be under wide ${wide}`);
});

test('a missing or nonsensical width falls back to the level default', () => {
  // clientWidth is 0 for a hidden element, which must not produce a
  // zero-column calendar.
  assert.equal(weeksForWidth(0, 'default'), CALENDAR_ZOOM.default.weeks);
  assert.equal(weeksForWidth(-50, 'default'), CALENDAR_ZOOM.default.weeks);
  assert.equal(weeksForWidth(NaN, 'default'), CALENDAR_ZOOM.default.weeks);
});

test('an unknown zoom name falls back to the default', () => {
  assert.deepEqual(zoomLevel('nonsense'), CALENDAR_ZOOM[DEFAULT_ZOOM]);
  assert.deepEqual(zoomLevel(undefined), CALENDAR_ZOOM[DEFAULT_ZOOM]);
  // `__proto__` resolves to Object.prototype on a plain lookup — the same
  // trap that once 500'd the settings endpoint.
  assert.deepEqual(zoomLevel('__proto__'), CALENDAR_ZOOM[DEFAULT_ZOOM]);
});
