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
