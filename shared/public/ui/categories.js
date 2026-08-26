/**
 * The category comparison: which of an account's categories is holding up.
 *
 * One card per category, each carrying the figures `GET /categories/stats`
 * computed and one `scoreChart` of that category's aggregate strength over the
 * window. Renders into the container `views.js` hands it, so the only element
 * id it owns is the top-bar button that opens it.
 *
 * **There is no category-level score formula.** What is drawn is the mean of
 * the members' own strengths, equal weight per habit, and the server decides
 * it — `computeCategoryStats` in `shared/src/stats.js` has the argument and
 * the warm-up this view would otherwise disagree with the habit's own page
 * about. Nothing here recomputes a figure; it draws what arrived.
 */

import { scoreChart } from '/shared/charts.js';
import { api } from '/shared/ui/api.js';
import { card } from '/shared/ui/components.js';
import * as routes from '/shared/ui/routes.js';
import { emit, on, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';
import * as views from '/shared/ui/views.js';

const $ = (sel) => document.querySelector(sel);

const compareBtn = $('#btn-compare');

/**
 * Weekly buckets, and the window the route opens for a caller that names no
 * start — a year, which is `COMPARE_WINDOW_DAYS`.
 *
 * A year of DAILY points is ~366 vertices in a card a phone renders at ~290px
 * wide, where the line is a smear rather than a shape; weekly is ~53, which is
 * legible at every width `responsive.mjs` checks. The granularity is also what
 * makes the axis line up with `computeHistory` at the same setting, so the two
 * surfaces bucket a week the same way — the server reads the account's
 * `weekStart` for both.
 */
const GRANULARITY = 'week';

/**
 * The chart is drawn at the width of the card it sits in, and the floor is
 * lower than the detail view's 320.
 *
 * That number protects a day grid, whose cells have a minimum size; a line
 * chart has no such thing, and a floor ABOVE the card is the defect
 * `cardInnerWidth`'s own comment records — `svg.chart { max-width: 100% }`
 * scales an oversized chart down rather than clipping it, so an SVG wider
 * than its box silently shrinks the whole drawing. 240 is under the ~286px a
 * card measures inside a 360px viewport, which is the narrowest
 * `responsive.mjs` checks.
 */
const MIN_CHART_WIDTH = 240;

/**
 * Usable width inside a card that is ALREADY in the grid, in CSS pixels.
 *
 * `cardInnerWidth` in `ui/components.js` measures a probe it appends, and a
 * probe cannot answer for this layout: `repeat(auto-fit, …)` collapses the
 * tracks with nothing in them, so a grid holding one hidden `.card` gives it
 * every pixel of the container. Measured on a 1440px window — the probe
 * reported 1026 for a column that is really 486, and the SVG then rendered at
 * 47% of the size it asked for, which is exactly the silent downscale that
 * function exists to prevent. So the cards are appended first and a real one
 * is measured, which needs no assumption about how many columns there turned
 * out to be.
 *
 * The arithmetic is the same as that function's, and for the same reason:
 * `.card` carries padding AND a border, and `clientWidth` already excludes
 * the border, so only the padding is subtracted. Reading it cannot drift from
 * the stylesheet.
 */
function innerWidthOf(cardEl) {
  const outer = cardEl?.clientWidth ?? 0;
  if (!outer) return 720;   // detached or hidden; the app's old fixed width
  const cs = getComputedStyle(cardEl);
  return outer - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

/**
 * Whether the account has a category at all, as last established.
 *
 * Remembered rather than re-read, because the two inputs to the button's
 * visibility move at different moments and by different means: this one
 * changes when the server is asked, and `openHabitId` changes when a view
 * opens. A caller that knows only the second must not have to invent an answer
 * to the first.
 */
let hasCategories = false;

/**
 * Show or hide the top-bar entry point.
 *
 * **Two constraints, one invariant.** The button is hidden unless the account
 * has a category — the comparison would otherwise be a single Uncategorised
 * card — AND it is hidden whenever a habit is open. The second is not a
 * tidiness rule, it is the other half of "this view links to no habit" below:
 * together they make it unreachable for a habit to sit UNDER the comparison in
 * the history stack. `ui/routes.js` keeps `ourEntry` as a single boolean and
 * `go(LIST)` unwinds with one `history.back()`, so the app is exactly one
 * fragment entry deep; `dashboard → habit → categories` would be two, and one
 * `back()` from there lands on `#/habit/N` with the dashboard painted under
 * it. Keeping the comparison enterable only from the dashboard is what makes
 * `ourEntry` honest. Weakening either constraint means teaching `routes.js` a
 * real stack first, and `android-native/CLAUDE.md` requires all three
 * back-stack rules re-read together and checked on an emulator for that.
 *
 * That the control comes and goes is a small cost and arguably the better
 * reading: the dashboard is where categories are compared, and a habit's own
 * page is about one habit. The top bar already varies — `#btn-logout` is in
 * the cloud edition only.
 *
 * `hasAny` is passed in rather than read off `state.categories`, because a
 * cold deep link straight to `#/categories` never paints the dashboard and has
 * the answer only in the response it just fetched. Omit it and the last answer
 * stands, which is what lets a caller that has moved only `openHabitId` — the
 * detail view — re-ask without knowing anything about categories.
 *
 * @param {boolean} [hasAny]
 */
export function syncEntry(hasAny) {
  if (hasAny !== undefined) hasCategories = hasAny;
  compareBtn.hidden = !hasCategories || state.openHabitId != null;
}

/**
 * Open (or redraw) the comparison.
 *
 * Reports whether it rendered, for the same reason `detail.open()` does: the
 * boot in `app.js` opens a deep link with no list behind it, so a refused
 * request has to leave something on screen.
 *
 * @returns {Promise<boolean>}
 */
export async function open() {
  try {
    const data = await api(`/categories/stats?granularity=${GRANULARITY}`);
    render(data);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

/**
 * Draw one response.
 *
 * The payload's shape is `CategoryStats` in `shared/src/types.js`, which this
 * file deliberately does not import a type from: `shared/src` is not served to
 * the browser, and `tsconfig.browser.json` maps `/shared/*` onto
 * `shared/public/` alone. The fields are named where they are read.
 *
 * @param {{buckets: string[], archivedExcluded: number, categories: any[]}} data
 */
function render(data) {
  // This view is now what is showing, and both flags say so — `openHabitId`
  // for every guard that already reads it, and `openCategories` for the two
  // that would otherwise treat "no habit open" as "the dashboard".
  state.openHabitId = null;
  state.openCategories = true;
  routes.go(routes.CATEGORIES);

  const host = views.showCategories();
  host.replaceChildren();

  syncEntry(data.categories.some((c) => c.id !== null));

  /* header */
  const head = document.createElement('div');
  head.className = 'detail-head';

  const back = document.createElement('button');
  back.className = 'btn btn-sm';
  back.textContent = '← Back';
  // Announced rather than called, exactly as the detail view's own Back is:
  // the dashboard owns its loading, and importing it from here would make the
  // two views mutually dependent.
  back.addEventListener('click', () => emit('reload'));

  const titleWrap = document.createElement('div');
  titleWrap.style.flex = '1';
  const h2 = document.createElement('h2');
  h2.textContent = 'Categories';
  const sub = document.createElement('div');
  sub.className = 'habit-sub';
  sub.textContent = [
    'Mean strength of each category’s habits, over the last year.',
    // Said here rather than left out: the figures below are over the ACTIVE
    // habits, and an account that has archived half of one of its categories
    // is owed the reason its card reads differently from its memory of it.
    data.archivedExcluded
      ? `${data.archivedExcluded} archived ${plural(data.archivedExcluded, 'habit')} left out.`
      : '',
  ].filter(Boolean).join(' ');
  titleWrap.append(h2, sub);

  head.append(back, titleWrap);
  host.append(head);

  const grid = document.createElement('div');
  grid.className = 'compare-grid';
  host.append(grid);

  // In two passes, because the chart's width is the width of the card it will
  // sit in and nothing can measure that until the grid holds its real
  // occupants — see `innerWidthOf`.
  const cards = data.categories.map((section) => sectionCard(section));
  grid.append(...cards.map((c) => c.el));

  const chartWidth = Math.max(MIN_CHART_WIDTH, innerWidthOf(cards[0]?.el));
  for (const { el, section } of cards) appendChart(el, section, chartWidth);
}

/** English plurals, for the three counts this view says out loud. */
const plural = (n, word) => (n === 1 ? word : `${word}s`);

/** A whole-number percentage, the way every other strength in the app reads. */
const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * One category's card, minus its chart.
 *
 * The section is handed back with it, because the second pass in `render`
 * needs both and pairing them there would be a second walk over the same
 * array in the same order — the kind of implicit correspondence that goes
 * wrong when somebody filters one of the two.
 *
 * @param {any} section  one `CategorySection` — see `render` on the types
 * @returns {{el: HTMLElement, section: any}}
 */
function sectionCard(section) {
  // Uncategorised arrives with `name: null` and `color: null`, because it is a
  // state a habit is in rather than a category anybody created — the server
  // has nothing to call it. Naming it belongs to the view, and this is the
  // same string `dashboard.js`'s trailing section header already uses.
  const name = section.name ?? 'Uncategorised';
  const c = card(name, null);
  c.className += section.id === null ? ' compare-card uncategorised' : ' compare-card';

  const title = c.querySelector('.card-title');
  const dot = document.createElement('span');
  // The swatch class the grouped dashboard and the habit dialog's manage list
  // already define, rather than a third small coloured dot with its own rule.
  dot.className = 'category-swatch';
  if (section.color) dot.style.background = section.color;
  title.prepend(dot);

  const figure = document.createElement('div');
  figure.className = 'compare-figure';

  const value = document.createElement('div');
  value.className = 'compare-mean';
  if (section.color) value.style.color = section.color;

  const note = document.createElement('div');
  note.className = 'compare-note';

  if (section.mean === null) {
    // **`mean` is null in two different situations and they are different
    // sentences.** An empty category has nobody to average; a category whose
    // members exist but have never been logged has members with no strength
    // YET, which is not a strength of zero — averaging one in would report
    // that the account got worse on the day it decided to do more. The count
    // that says so is `unloggedExcluded`, so it is what the second sentence
    // reports in place of a figure nobody can be given.
    value.textContent = '—';
    note.textContent = section.members === 0
      ? 'No habits in this category yet.'
      : `${section.members} ${plural(section.members, 'habit')}, `
        + `${section.unloggedExcluded === 1 ? 'never logged' : 'none logged yet'}`
        + ' — no strength to average.';
  } else {
    value.textContent = pct(section.mean);
    note.textContent = [
      `over ${section.members} ${plural(section.members, 'habit')}`,
      section.unloggedExcluded
        ? `${section.unloggedExcluded} never logged, left out`
        : '',
    ].filter(Boolean).join(' · ');
  }
  figure.append(value, note);
  c.append(figure);

  const spread = document.createElement('div');
  spread.className = 'compare-spread';
  // **Best and worst are NAMED and linked to nothing, deliberately.**
  // `ui/routes.js` keeps a single `ourEntry` boolean and `go(LIST)` reaches
  // the dashboard with one `history.back()`, so the app is exactly one
  // fragment entry deep at all times. A link from here to a habit would make
  // `dashboard → categories → habit` two of ours, and Back from that habit
  // would land on `#/categories` with the dashboard painted underneath it —
  // in the Android WebView that is the system back gesture, and
  // `android-native/CLAUDE.md`'s back-stack section states the assumption it
  // breaks: "that unwind assumes the entry underneath a habit is the
  // dashboard". This is the same invariant `syncEntry` above keeps from the
  // other side, and the two are only safe together: no habit above the
  // comparison, no comparison above a habit. Making these links needs that
  // unwind to become a real stack first. Do not add an `<a>` here.
  if (section.best && section.worst) {
    spread.append(
      member('Best', section.best),
      member('Weakest', section.worst),
    );
    c.append(spread);
  }

  // An empty category gets no recovery line at all. "No recovered lapses to
  // rate." is true of one and says the same nothing the figure above it has
  // already said — a section with no members has nothing to report about, and
  // two sentences reporting it is one more than the reader needs.
  if (section.members) {
    const recovery = document.createElement('div');
    recovery.className = 'compare-note';
    recovery.textContent = section.recoveryRate === null
      // `null` is "no lapse in this window has been recovered from", which is a
      // different claim from a rate of 100% and must not render as a number —
      // the same rule `computeRecovery`'s own `rate === null` carries.
      ? 'No recovered lapses to rate.'
      : `Recovers from ${pct(section.recoveryRate)} of lapses`
        + (section.recoveryExcluded
          ? ` · ${section.recoveryExcluded} ${plural(section.recoveryExcluded, 'habit')} with none to rate`
          : '');
    c.append(recovery);
  }

  return { el: c, section };
}

/**
 * The category's aggregate strength, once the card is in the grid and its
 * width can be measured.
 *
 * @param {HTMLElement} c
 * @param {any} section
 * @param {number} chartWidth
 */
function appendChart(c, section, chartWidth) {
  // **A member joins the line when its first entry lands**, so the leading
  // nulls are dropped rather than plotted as zero: a habit added last month
  // must read as a line STARTING, never as a step down in the aggregate.
  // `series` is already built that way by `computeCategoryStats`; all this
  // does is decline to invent a point where it reported none. Left in, a null
  // reaches `scoreChart`'s path arithmetic and every coordinate after it is
  // NaN — one absent member and the whole line disappears.
  const points = section.series
    .filter((p) => p.value !== null)
    .map((p) => ({ date: p.bucket, score: p.value }));

  if (!points.length) {
    const none = document.createElement('div');
    none.className = 'compare-note';
    // Said rather than left blank: an empty space under a figure of '—' reads
    // as a chart that failed to draw.
    none.textContent = section.members
      ? 'Nothing logged in this window.'
      : 'Nothing to chart.';
    c.append(none);
    return;
  }

  // **The colour is NAMED, never resolved.** A category's own colour is a
  // literal the user picked, and Uncategorised has none — so it takes a theme
  // variable as a `var()` reference that CSS resolves on every paint, rather
  // than a value read out with `getComputedStyle` at draw time, which would
  // freeze the light palette into the attribute and leave the line invisible
  // after a theme switch with no redraw to correct it.
  const svg = scoreChart(points, section.color ?? 'var(--text-dim)', {
    width: chartWidth,
    height: 140,
  });
  // `scoreChart` labels itself for the one habit it was written for; here
  // there are several on one page and a screen reader would meet the same
  // sentence five times with nothing to tell them apart.
  svg.setAttribute('aria-label',
    `${section.name ?? 'Uncategorised'}: mean habit strength over time`);
  c.append(svg);
}

/**
 * One end of the spread, as text.
 * @param {string} label
 * @param {{id: number, name: string, score: number}} m
 */
function member(label, m) {
  const wrap = document.createElement('div');
  wrap.className = 'compare-member';

  const l = document.createElement('span');
  l.className = 'compare-member-label';
  l.textContent = label;

  const n = document.createElement('span');
  n.className = 'compare-member-name';
  n.textContent = m.name;

  const v = document.createElement('span');
  v.className = 'compare-member-score';
  v.textContent = pct(m.score);

  wrap.append(l, n, v);
  return wrap;
}

export function init() {
  compareBtn.addEventListener('click', () => { open(); });

  // Nothing this view shows can be recomputed from `state` — every figure on
  // it was computed by the server over a window this page chose — so a
  // 'change' is a refetch rather than a repaint, exactly as it is in
  // `ui/detail.js`. 'reload' is not handled here for the same reason it is not
  // handled there: it means "go to the dashboard", which is the dashboard's
  // business, and the Back button above is one of its emitters.
  on('change', () => { if (state.openCategories) open(); });
}
