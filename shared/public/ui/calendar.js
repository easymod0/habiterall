/**
 * Layout maths for the completion calendar.
 *
 * Kept out of charts.js — and free of any DOM — so the date arithmetic can be
 * tested in Node. It is the part that has actually been wrong: the grid used
 * to be anchored on its start, which silently cut today off the end.
 *
 * Lives under public/ rather than src/ because charts.js loads it in the
 * browser, and only public/ is served.
 */

/**
 * Cell geometry per zoom level.
 *
 * `weeks` is a *minimum* — how much history the level is meant to show. The
 * grid grows past it to fill whatever width is available (see `weeksForWidth`),
 * so zoom controls how big the squares are, and the window sizes itself to the
 * screen rather than leaving half a desktop card empty.
 */
export const CALENDAR_ZOOM = {
  closest: { cell: 30, gap: 6, weeks: 8 },   // ~2 months, very large squares
  close:   { cell: 20, gap: 4, weeks: 14 },  // ~3 months, easy to tap
  default: { cell: 13, gap: 3, weeks: 27 },  // ~6 months
  wide:    { cell: 8,  gap: 2, weeks: 53 },  // ~1 year, GitHub-sized
};

/** Space to the left of the grid, for the weekday labels. */
export const CALENDAR_PAD_LEFT = 22;

/**
 * How many week columns fit in `available` pixels at a given zoom.
 *
 * Never fewer than the level's own `weeks`, so a narrow screen still scrolls
 * through the intended span instead of silently showing a fortnight; and
 * capped so a very wide monitor does not ask for a decade of history.
 *
 * @param {number} available  usable width in CSS pixels
 * @param {string} zoom
 * @param {number} [max]      hard ceiling on columns
 */
export function weeksForWidth(available, zoom, max = 105) {
  const { cell, gap, weeks } = zoomLevel(zoom);
  if (!Number.isFinite(available) || available <= 0) return weeks;

  // The drawn width is padLeft + weeks*(cell+gap), and the final column needs
  // no trailing gap. Subtracting it here keeps the SVG from overshooting the
  // container by one gap — which `max-width: 100%` would otherwise absorb by
  // scaling the whole grid down, making 13px cells render at 12.6px.
  const usable = available - CALENDAR_PAD_LEFT + gap;
  const fits = Math.floor(usable / (cell + gap));
  return Math.max(weeks, Math.min(max, fits));
}

/** Exact drawn width for a grid, so a caller can check it fits. */
export function calendarWidth(weeks, zoom) {
  const { cell, gap } = zoomLevel(zoom);
  return CALENDAR_PAD_LEFT + weeks * (cell + gap) - gap;
}

/** The zoom level to use when a stored value is missing or unrecognised. */
export const DEFAULT_ZOOM = 'default';

/**
 * @param {string} name
 * @returns {{cell: number, gap: number, weeks: number}}
 */
export function zoomLevel(name) {
  // Own-property check, not a plain lookup: CALENDAR_ZOOM['__proto__'] returns
  // Object.prototype, which is truthy, so `??` would hand back an object with
  // no cell/gap/weeks and the calendar would render at NaN sizes.
  return Object.hasOwn(CALENDAR_ZOOM, name ?? '')
    ? CALENDAR_ZOOM[name]
    : CALENDAR_ZOOM[DEFAULT_ZOOM];
}

/** Local-midnight Date from 'YYYY-MM-DD', avoiding UTC parsing drift. */
function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 'YYYY-MM-DD' from a local Date. */
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The date window a calendar of `weeks` columns ending at `endDate` covers.
 *
 * The window is anchored on its END. The last column is the whole week
 * containing `endDate` — so `endDate` itself is always drawn — and the start
 * is `weeks` whole weeks back from there, always landing on a Sunday so the
 * weekday rows line up.
 *
 * Anchoring on the start instead (go back weeks*7 days, then snap backwards
 * to a Sunday) shifts the entire grid earlier by however many days into the
 * week `endDate` falls, which hides today on six days out of seven.
 *
 * @param {string} endDate  last date that must be visible, 'YYYY-MM-DD'
 * @param {number} weeks    number of columns
 * @returns {{start: string, end: string}} first and last cell in the grid
 */
export function calendarWindow(endDate, weeks) {
  const end = fromISO(endDate);

  // Saturday closing endDate's week.
  const lastCell = new Date(end);
  lastCell.setDate(lastCell.getDate() + (6 - lastCell.getDay()));

  const start = new Date(lastCell);
  start.setDate(start.getDate() - (weeks * 7 - 1));

  return { start: toISO(start), end: toISO(lastCell) };
}
