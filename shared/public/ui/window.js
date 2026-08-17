/**
 * How many columns a chart can show before its bars become unreadable, and
 * which slice of the data to render.
 *
 * The calendar already pages through history rather than cramming a decade
 * into one screen. Every other chart with an unbounded time axis has the same
 * problem — `slot = width / buckets.length` silently shrinks bars to 2px once
 * you have a year of daily data — so they share this logic and the same
 * ‹ Earlier / Later › controls.
 *
 * The dashboard's day grid asks the same question of a viewport rather than of
 * a card, so `gridColumns` lives here too — beside the arithmetic it resembles,
 * and inside a module the service worker already ships, which a file of its own
 * would not be.
 *
 * DOM-free, so it can be unit tested in Node.
 */

/**
 * Minimum horizontal space per column, in CSS pixels, for each kind of chart.
 * These are the widths below which the chart stops communicating: a bar
 * narrower than ~8px is a hairline, and a circle needs room for its diameter
 * plus a gap or the rows merge into stripes.
 */
export const MIN_SLOT = {
  bar: 10,      // history: bar plus breathing room
  circle: 22,   // weekday/frequency dot grids: diameter plus a gap
  point: 6,     // line charts: only needs enough to see the vertices
};

/**
 * How many columns fit in `width` at the given density.
 *
 * @param {number} width      usable pixels for the plot area
 * @param {keyof typeof MIN_SLOT|number} density  a MIN_SLOT key, or a pixel figure
 * @param {number} [reserved] axis labels and padding to subtract
 * @returns {number} at least 1
 */
export function columnsForWidth(width, density = 'bar', reserved = 46) {
  const min = typeof density === 'number'
    ? density
    : (Object.hasOwn(MIN_SLOT, density) ? MIN_SLOT[density] : MIN_SLOT.bar);

  const usable = (Number.isFinite(width) ? width : 0) - reserved;
  if (usable <= 0) return 1;
  return Math.max(1, Math.floor(usable / min));
}

/* ---------- the dashboard's day grid ---------- */

/**
 * How many day columns the habit grid shows, per viewport band.
 *
 * Not one breakpoint: at 768px the 14-column desktop layout needed 668px of a
 * 698px row, leaving nothing for the habit name. Under 640px the CSS switches
 * to flexible columns, so the narrow count applies there.
 *
 * `GRID_DAYS` is also what `load()` asks `/overview` for, which is why it is
 * exported: the fetch is always the widest count the grid could ever show.
 */
export const GRID_DAYS = 14;         // most columns we will ever show
export const GRID_DAYS_NARROW = 7;   // phone layout: fewer, wider columns
export const GRID_DAYS_MEDIUM = 10;  // tablets, where 14 would crush the name

/** Today's per-width ladder, which is what `auto` means. */
function fitsFor(width) {
  if (width <= 640) return GRID_DAYS_NARROW;
  if (width <= 900) return GRID_DAYS_MEDIUM;
  return GRID_DAYS;
}

/**
 * How many day columns to draw, given the account's `gridDays` and the
 * viewport.
 *
 * **The setting is a CAP, never an absolute**, and that is the whole design.
 * The per-width ladder above is not a style choice — it is the fix for a real
 * bug — so a phone asked for fourteen columns still gets seven. `Math.min` is
 * the entire rule, and removing it reintroduces exactly what `responsive.mjs`
 * was written to catch.
 *
 * Every offered value is therefore ≤ `GRID_DAYS`. That is what keeps `load()`
 * out of this: the widest count the grid can ever show is unchanged, so
 * changing the setting cannot outrun the window that was fetched, and no route
 * in either edition needs to know this exists.
 *
 * Anything unrecognised — `auto`, an absent setting, a stale value from an
 * older build — falls back to the ladder rather than to a number, since a
 * ladder is what this did before the setting existed.
 *
 * @param {string|number} [chosen]  the stored setting: 'auto' or a count
 * @param {number} [width]          viewport width in CSS pixels
 * @returns {number} at least 1
 */
export function gridColumns(chosen, width) {
  const ladder = fitsFor(Number.isFinite(width) ? Number(width) : 0);
  const asked = Number(chosen);
  if (!Number.isInteger(asked) || asked < 1) return ladder;
  return Math.min(asked, ladder);
}

/**
 * The slice of `items` to render, given a paging offset.
 *
 * `offset` counts columns back from the most recent: 0 is the latest window,
 * a positive number scrolls into the past. It is clamped, so paging past
 * either end is a no-op rather than an empty chart.
 *
 * @template T
 * @param {T[]} items      oldest first
 * @param {number} capacity columns that fit
 * @param {number} offset  columns scrolled back from the end
 * @returns {{slice: T[], offset: number, canGoEarlier: boolean,
 *            canGoLater: boolean, total: number, from: number}}
 */
export function windowSlice(items, capacity, offset = 0) {
  const total = items.length;
  const size = Math.max(1, Math.min(capacity, total));
  const maxOffset = Math.max(0, total - size);
  const clamped = Math.max(0, Math.min(offset, maxOffset));

  const from = total - size - clamped;
  return {
    slice: items.slice(from, from + size),
    offset: clamped,
    canGoEarlier: clamped < maxOffset,
    canGoLater: clamped > 0,
    total,
    from,
  };
}
