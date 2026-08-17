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

// A relative specifier, which is what lets `calendar.test.js` load this module
// under Node — the absolute `/shared/...` form the rest of `public/ui` uses
// does not resolve there. This module held a third byte-identical copy of
// `iso`, which is one storage-key builder per file that needed one.
import { iso as toISO } from './dates.js';

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



/**
 * The date window a calendar of `weeks` columns ending at `endDate` covers.
 *
 * The window is anchored on its END. The last column is the whole week
 * containing `endDate` — so `endDate` itself is always drawn — and the start
 * is `weeks` whole weeks back from there, landing on the first day of a week
 * so the weekday rows line up.
 *
 * Anchoring on the start instead (go back weeks*7 days, then snap backwards)
 * shifts the entire grid earlier by however many days into the week `endDate`
 * falls, which hides today on six days out of seven.
 *
 * **Which day starts a week is the account's, and it was hard-coded here.**
 * `weekStart` was honoured by `startOfWeek` in stats.js — so the history and
 * times-per-week charts bucketed on the right day — while this snapped
 * unconditionally to Saturday/Sunday. Someone whose week starts on Monday got a
 * Sunday-anchored heatmap on the chart the detail view opens to, with the
 * weekday labels beside it saying otherwise. The setting's own help text says
 * it is "used by the history and times-per-week charts", which is literally
 * true and is how it went unnoticed.
 *
 * @param {string} endDate  last date that must be visible, 'YYYY-MM-DD'
 * @param {number} weeks    number of columns
 * @param {'monday'|'sunday'} [weekStart] which day a column begins on;
 *   defaults to the registry's own default, so a caller that forgets gets the
 *   app's answer rather than a third one
 * @returns {{start: string, end: string}} first and last cell in the grid
 */
export function calendarWindow(endDate, weeks, weekStart = 'monday') {
  const end = fromISO(endDate);

  // The last day of endDate's week — Saturday for a Sunday-start week, Sunday
  // for a Monday-start one. `weekdayIndex` is the offset from the first day.
  const lastCell = new Date(end);
  lastCell.setDate(lastCell.getDate() + (6 - weekdayIndex(end, weekStart)));

  const start = new Date(lastCell);
  start.setDate(start.getDate() - (weeks * 7 - 1));

  return { start: toISO(start), end: toISO(lastCell) };
}

/**
 * How far into its week a date falls, 0-6, counting from `weekStart`.
 *
 * `getDay()` is always Sunday-based, so this is the one place that translates.
 * The calendar's ROWS are the same index, which is why it is exported: the
 * heatmap draws row `weekdayIndex(date)` and labels it from the same rotation,
 * and the two reading `getDay()` separately is how a Monday-start grid would
 * end up with Sunday's label on Monday's row.
 *
 * @param {Date} date
 * @param {'monday'|'sunday'} [weekStart]
 * @returns {number}
 */
export function weekdayIndex(date, weekStart = 'monday') {
  const day = date.getDay();
  return weekStart === 'monday' ? (day + 6) % 7 : day;
}
