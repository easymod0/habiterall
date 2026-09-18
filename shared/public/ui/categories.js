/**
 * The two category views: which of an account's categories is holding up, and
 * one category's own page.
 *
 * The comparison (`#/categories`) is one card per category, each carrying the
 * figures `GET /categories/stats` computed and one `scoreChart` of that
 * category's aggregate strength over the window. A category's own page
 * (`#/category/<id>`) is the same figures for one of them, at full width, plus
 * the roster of its members and their own strengths. Both render into the
 * container `views.js` hands them — the SAME one — so the only element id this
 * module owns is the top-bar button that opens the first.
 *
 * **Both live here rather than in a file of their own**, because what keeps
 * the history stack one entry deep is shared state: `syncEntry` and the
 * module-level `hasCategories` below, and `openSeq`, the one ticket both views
 * take so that only the newest reply may paint the container they share.
 * Splitting them would put part of that invariant in each file and a new
 * module in `sw.js`'s `SHELL`.
 *
 * **There is no category-level score formula.** What is drawn is the mean of
 * the members' own strengths, equal weight per habit, and the server decides
 * it — `computeCategoryStats` in `shared/src/stats.js` has the argument and
 * the warm-up this view would otherwise disagree with the habit's own page
 * about. Nothing here recomputes a figure; it draws what arrived.
 */

import { scoreChart } from '/shared/charts.js';
import { api } from '/shared/ui/api.js';
import { card, subheading } from '/shared/ui/components.js';
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
 * **Three constraints, one invariant.** The button is hidden unless the account
 * has a category — the comparison would otherwise be a single Uncategorised
 * card — AND it is hidden whenever a habit is open, AND whenever a category's
 * own page is. The last two are not tidiness rules, they are the other half of
 * "this view links to no habit" below: together they make it unreachable to
 * NAVIGATE a habit under the comparison in the history stack. `ui/routes.js`
 * keeps `ourEntry` as a single boolean and `go(LIST)` unwinds with one
 * `history.back()`, so the app is exactly one fragment entry deep;
 * `dashboard → habit → categories` would be two, and one `back()` from there
 * lands on `#/habit/N` with the dashboard painted under it.
 *
 * The third clause closes the same hole from the third side, and it is the
 * whole reason `dashboard → category → categories` is unreachable: a category's
 * own page is itself one entry of ours, so offering the comparison from it
 * would stack a second. Keeping both category views enterable only from the
 * dashboard is what makes `ourEntry` honest. Weakening any of the three means
 * teaching `routes.js` a real stack first (issue #348), and
 * `android-native/CLAUDE.md` requires all three back-stack rules re-read
 * together and checked on an emulator for that.
 *
 * **What the three rules bound is what a user can navigate INTO, and that is
 * the whole of the claim.** A view opened while another view's request is
 * still in flight can still stack a second entry when the older reply lands
 * and writes its own URL — `openSeq` below closes that between these two
 * views and cannot see the cross-view case, which `ui/detail.js`'s ticket
 * cannot see either. It is pre-existing rather than something the third view
 * introduced, and #348 is where it is closed.
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
  compareBtn.hidden = !hasCategories
    || state.openHabitId != null
    || state.openCategoryId != null;
}

/**
 * Which request for this container is the current one, and so which reply may
 * still be DRAWN.
 *
 * `openSeq` in `ui/detail.js`, in the same shape and for the same reason: a
 * caller takes a number before its request goes out, and only a reply still
 * holding that number may render. A counter and not a timestamp, because two
 * of these can start inside one millisecond.
 *
 * **ONE counter for both views, because they paint one container.** `render`
 * and `renderOne` both own `#view-categories` and both write the URL through
 * `routes.go`, so only the newest of them can honestly be what is showing —
 * there is no question a second counter here would be answering. That matters
 * beyond a wasted repaint, because `routes.go`'s push branch has no `ourEntry`
 * guard on it: with nothing to discard the older reply, two presses on two
 * different section headers push two entries, and one `history.back()` out of
 * that lands on a category page with the dashboard painted beneath it
 * (`ui/routes.js`). Nothing synchronous happens here before the `await`, and
 * `/categories/stats` is the heaviest route in the app, so the dashboard stays
 * interactive for the whole flight — the interval is a real one rather than a
 * theoretical one.
 *
 * **What it does NOT cover, and the claim to keep narrow**: a counter in this
 * module is bumped only by this module, so it closes the race between two
 * presses INSIDE this file and nothing else. A habit opened over an in-flight
 * `/categories/stats` still lets the older category reply land — it renders
 * over the habit's page and its `routes.go` pushes `#/category/<id>` on top of
 * `#/habit/<id>`, which is the same two-deep stack in a race this cannot see.
 * `ui/detail.js`'s own ticket has the identical boundary from the other side.
 * So the three rules `syncEntry` states make it unreachable to NAVIGATE into a
 * two-deep stack; a request already in flight when a second view opens is a
 * separate, pre-existing hole, and closing it needs one counter above both
 * views rather than a second one here (issue #348).
 */
let openSeq = 0;

/**
 * Open (or redraw) the comparison.
 *
 * Reports whether it rendered, for the same reason `detail.open()` does: the
 * boot in `app.js` opens a deep link with no list behind it, so a refused
 * request has to leave something on screen. **A DISCARDED reply is not a
 * refusal and answers `true`** — same narrowing, and the same argument, as
 * `detail.open()`'s: whatever superseded this call owns the screen, so
 * answering `false` would send that boot to the dashboard over a page
 * something newer is about to draw.
 *
 * @returns {Promise<boolean>}
 */
export async function open() {
  // Taken before anything is awaited, so the number describes THIS request.
  const ticket = ++openSeq;
  try {
    const data = await api(`/categories/stats?granularity=${GRANULARITY}`);
    if (ticket !== openSeq) return true;
    render(data);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

/**
 * Open (or redraw) ONE category's own page.
 *
 * **The same url `open()` fetches, with one section picked out of the answer.**
 * One fetch, one window, one arithmetic — so the mean printed here is the same
 * number the comparison prints on that category's card, and the members listed
 * under it are the ones that fed it, rather than a second figure over a second
 * window that disagrees with both. A route of its own, or a member list joined
 * client-side out of `/overview`, would each be that second window.
 *
 * **The dashboard's grouped section header is a different window, and it can
 * print a different number for this same category.** That header's mean comes
 * from `/overview`'s `categorySummaries` — `summariseByCategory` over
 * `summaryStats`, a fixed 400-day window anchored on today with no forward
 * clamp to the member's own first entry — where this page is
 * `COMPARE_WINDOW_DAYS` plus the 400-day warm-up, clamped forward per member.
 * For a slow habit the two genuinely diverge (measured, a perfect 1x/90d habit
 * 700 days old: 98% here against 85% there). It is a pre-existing limitation
 * rather than something this page introduced — both surfaces are on master —
 * and `docs/decisions/categories.md` phase 6 has the figures and why it is not
 * closed here.
 *
 * Reports whether it rendered, for the reason `open()` and `detail.open()` do:
 * the boot in `app.js` opens a deep link with no list behind it, so a refused
 * request — or a bookmark naming a category that has since been deleted — has
 * to leave something on screen. A DISCARDED reply answers `true`, for the
 * reason `open()` above states.
 *
 * @param {number} id
 * @returns {Promise<boolean>}
 */
export async function openCategory(id) {
  // Taken before anything is awaited, so the number describes THIS request —
  // see `openSeq` above for what a second press in this interval would
  // otherwise push onto the history stack.
  const ticket = ++openSeq;
  try {
    const data = await api(`/categories/stats?granularity=${GRANULARITY}`);
    // Superseded while this was out: DISCARDED, and before the section is
    // looked up rather than after. One rule at the one moment that matters —
    // and a reply nothing may draw must not toast about a category either,
    // since the sentence below would be about a press the user has already
    // moved on from.
    if (ticket !== openSeq) return true;
    const section = data.categories.find((c) => c.id === id);
    if (!section) {
      // A bookmark, a shared link or the address bar naming a category this
      // account no longer has. Said out loud and reported as a refusal rather
      // than thrown: `app.js`'s boot reads the boolean and falls back to the
      // dashboard, which is a page, where a rendered empty one is not.
      //
      // **The id is dropped HERE and not in the `catch`**, because this is the
      // one refusal nothing can undo: the reply was good and the category was
      // not in it. Held, a dead id keeps the page notionally open — `syncEntry`
      // goes on hiding the top-bar button, `dashboardShowing()` goes on
      // answering false, `#/category/<dead id>` stays live, and every later
      // 'change' re-toasts about a category that is gone. A request that merely
      // FAILED says nothing about whether the category exists, so it keeps the
      // id and keeps the page.
      state.openCategoryId = null;
      toast('That category no longer exists.');
      return false;
    }
    renderOne(section, data);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

/**
 * Draw one category's own page.
 *
 * It reuses `#view-categories` (`views.showCategories()`) rather than taking a
 * container of its own: both category views are owned by this file, which is
 * also what keeps the back-stack tax — `syncEntry` and `hasCategories` — in
 * one place. **This page links to no habit**, for the reason spelled out over
 * the spread in `sectionCard` below.
 *
 * @param {any} section  the one `CategorySection` — see `render` on the types
 * @param {{categories: any[]}} data  the whole reply it came out of
 */
function renderOne(section, data) {
  // All three flags, explicitly rather than by implication: this page is not a
  // habit and not the comparison, and whichever of those the user arrived from
  // has left its own flag set. `dashboardShowing()` is the one reader that
  // matters and it asks about all three.
  state.openHabitId = null;
  state.openCategories = false;
  state.openCategoryId = section.id;
  routes.go({ view: 'category', id: section.id });

  const host = views.showCategories();
  host.replaceChildren();

  // Re-asked for this view, because the top-bar button is hidden while this
  // page is open — the third clause in `syncEntry`, and the half of the depth
  // invariant that makes `dashboard → category → categories` unreachable.
  // `hasAny` from the reply in hand, for the cold-deep-link reason `syncEntry`
  // states: a boot straight to this fragment never paints the dashboard.
  syncEntry(data.categories.some((c) => c.id !== null));

  /* header */
  const head = document.createElement('div');
  head.className = 'detail-head';

  const back = document.createElement('button');
  back.className = 'btn btn-sm';
  back.textContent = '← Back';
  // Announced rather than called, exactly as the comparison's own Back is: the
  // dashboard owns its loading, and importing it from here would make the two
  // views mutually dependent.
  back.addEventListener('click', () => emit('reload'));

  const titleWrap = document.createElement('div');
  titleWrap.style.flex = '1';
  const h2 = document.createElement('h2');
  // The swatch is a 12px BOX, so it needs a flex line to sit on — which every
  // other surface gives it from a rule of its own (`.compare-card .card-title`,
  // the dashboard's section header). Said here rather than added to the
  // stylesheet as a third rule for one element on one page.
  h2.style.display = 'flex';
  h2.style.alignItems = 'center';
  h2.style.gap = '8px';
  const dot = document.createElement('span');
  dot.className = 'category-swatch';
  if (section.color) dot.style.background = section.color;
  const nameText = document.createElement('span');
  // Uncategorised has no page — the route is digits-only, so `#/category/null`
  // cannot be spelled — but the fallback is kept rather than assumed away: a
  // section that arrives without a name must still draw a heading.
  nameText.textContent = section.name ?? 'Uncategorised';
  h2.append(dot, nameText);

  const sub = document.createElement('div');
  sub.className = 'habit-sub';
  sub.textContent = [
    'Mean strength of this category’s habits, over the last year.',
    // This SECTION's own count, not the account-wide one the comparison's
    // header states: the figures below are over the active members of this one
    // category, and `data.archivedExcluded` cannot answer for it.
    section.archivedExcluded
      ? `${section.archivedExcluded} archived `
        + `${plural(section.archivedExcluded, 'habit')} left out.`
      : '',
  ].filter(Boolean).join(' ');
  titleWrap.append(h2, sub);

  head.append(back, titleWrap);
  host.append(head);

  // A bare `.card` rather than `card(...)`: the page's one card carries no
  // title of its own — the `<h2>` above names the category — and an empty
  // `.card-head` would leave its bottom margin behind a blank line.
  const c = document.createElement('div');
  c.className = 'card';
  host.append(c);

  // The same figure and the same recovery sentence the comparison's card
  // draws, from the same two builders: one wording for both views, including
  // every branch of "there is no mean to print and here is why".
  c.append(sectionFigure(section));
  const recovery = recoveryLine(section);
  if (recovery) c.append(recovery);

  // Measured once the card is in the document, for the reason `innerWidthOf`
  // gives — and at the full width of the view rather than a grid column, since
  // there is one card here and no `auto-fit` tracks to collapse.
  appendChart(c, section, Math.max(MIN_CHART_WIDTH, innerWidthOf(c)));

  // The roster, as the payload listed it. `?? []` covers one window and not a
  // shape this code is unsure of: `shellFirst` can serve this module while the
  // still-running old worker answers `/categories/stats` from a data cache
  // filled before the field existed, and a throw here lands AFTER
  // `host.replaceChildren()` — a blank page rather than a page missing a list.
  const roster = section.roster ?? [];
  if (roster.length) {
    c.append(subheading('Habits'));
    const list = document.createElement('div');
    list.className = 'compare-spread';
    // **Every member is NAMED and linked to nothing**, which is the same tax
    // the spread below pays and says out loud: the app is exactly one fragment
    // entry deep, `dashboard → category → habit` would be two of ours, and
    // Back from that habit would land on `#/category/N` with the dashboard
    // painted underneath it. So these rows are `<div>`s — never an `<a>` and
    // never a `<button>` — and nothing styles them as though they were, since
    // a row that looks like a way in and is not is the complaint this whole
    // page came from. Lifting the ceiling is issue #348.
    for (const m of roster) list.append(member(null, m));
    c.append(list);
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
  // This view is now what is showing, and all three flags say so —
  // `openHabitId` for every guard that already reads it, `openCategories` for
  // the ones that would otherwise treat "no habit open" as "the dashboard",
  // and `openCategoryId` because one category's own page is the third thing
  // this one is not. Left set, `dashboardShowing()` goes on answering false
  // after the user has gone home.
  state.openHabitId = null;
  state.openCategories = true;
  state.openCategoryId = null;
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

/** English plurals, for the counts this view says out loud. */
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

  c.append(sectionFigure(section));

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
  // comparison, no comparison above a habit. The category page `renderOne`
  // draws pays the same tax for the same reason, over its whole roster.
  // Making these links needs that unwind to become a real stack first
  // (issue #348). Do not add an `<a>` here.
  if (section.best && section.worst) {
    spread.append(
      member('Best', section.best),
      member('Weakest', section.worst),
    );
    c.append(spread);
  }

  const recovery = recoveryLine(section);
  if (recovery) c.append(recovery);

  return { el: c, section };
}

/**
 * The mean, and the sentence under it saying what it is over.
 *
 * Its own function because BOTH category views print it — the comparison's
 * card and one category's own page — and every branch below is a wording
 * decision rather than a layout one. Two copies of these sentences is two
 * answers to "why is there no figure here", which is the question they exist
 * to answer.
 *
 * @param {any} section  one `CategorySection`
 * @returns {HTMLElement}
 */
function sectionFigure(section) {
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
    if (section.members === 0) {
      // ...and an EMPTY category is two situations as well. Archived habits are
      // left out of every figure, so a category the user filled and later
      // shelved arrives here with `members: 0` and is otherwise
      // indistinguishable from one nobody has put anything in — and the card
      // then states something false about it. The account-wide
      // `data.archivedExcluded` in the header cannot answer for one section,
      // which is why `CategorySection` carries its own count.
      note.textContent = section.archivedExcluded
        ? `${section.archivedExcluded} archived `
          + `${plural(section.archivedExcluded, 'habit')}, nothing active to average.`
        : 'No habits in this category yet.';
    } else {
      note.textContent = `${section.members} ${plural(section.members, 'habit')}, `
        + `${section.unloggedExcluded === 1 ? 'never logged' : 'none logged yet'}`
        + ' — no strength to average.';
    }
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
  return figure;
}

/**
 * How often this category's members come back from a lapse, as a sentence —
 * or nothing at all, for a category with no members.
 *
 * Both views draw it, for the reason `sectionFigure` above is shared: the
 * refusal to print a rate of `null` as a number is a claim about the data, not
 * a decision either view gets to make for itself.
 *
 * An empty category gets no recovery line at all. "No recovered lapses to
 * rate." is true of one and says the same nothing the figure above it has
 * already said — a section with no members has nothing to report about, and
 * two sentences reporting it is one more than the reader needs.
 *
 * @param {any} section  one `CategorySection`
 * @returns {HTMLElement|null}
 */
function recoveryLine(section) {
  if (!section.members) return null;

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
  return recovery;
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
 * One member, as text: an end of the spread on the comparison, a roster row on
 * a category's own page. A `<div>` of `<span>`s in both — never an `<a>` and
 * never a `<button>` — see the note over the spread in `sectionCard`.
 *
 * Two arguments are wider than the spread needs, and each widening is one of
 * the two views: `label` is `null` on a roster row, where the name starts the
 * line and there is no "Best"/"Weakest" to say; and `score` is `null` for a
 * member that has NEVER been logged, which `best`/`worst` can never be, since
 * they are only ever chosen from members that have landed.
 *
 * @param {string|null} label
 * @param {{id: number, name: string, score: number|null}} m
 */
function member(label, m) {
  const wrap = document.createElement('div');
  wrap.className = 'compare-member';

  const n = document.createElement('span');
  n.className = 'compare-member-name';
  n.textContent = m.name;

  const v = document.createElement('span');
  v.className = 'compare-member-score';
  // **Never logged is said in words, and never as 0%** — no strength is not a
  // strength of zero, the same claim the payload makes by sending `null` and
  // the figure above makes by leaving that member out of the mean. Not a bare
  // dash either, which reads as a figure that failed to load.
  v.textContent = m.score === null ? 'never logged' : pct(m.score);

  if (label === null) {
    wrap.append(n, v);
    return wrap;
  }

  const l = document.createElement('span');
  l.className = 'compare-member-label';
  l.textContent = label;

  wrap.append(l, n, v);
  return wrap;
}

export function init() {
  compareBtn.addEventListener('click', () => { open(); });

  // Nothing either view shows can be recomputed from `state` — every figure on
  // them was computed by the server over a window this page chose — so a
  // 'change' is a refetch rather than a repaint, exactly as it is in
  // `ui/detail.js`. 'reload' is not handled here for the same reason it is not
  // handled there: it means "go to the dashboard", which is the dashboard's
  // business, and the Back buttons above are two of its emitters.
  //
  // **Both views, because this module owns both.** The flags are mutually
  // exclusive, so the `else if` is the second view's whole wiring: without it,
  // saving a habit from the dialog opened over a category's own page leaves
  // that page showing the figures it was drawn with.
  //
  // **And a refetch that finds the category GONE goes home**, which is the
  // delete-the-open-category case and not a theoretical one: `#btn-new` is
  // never hidden per view, so the habit dialog — and the category manage list
  // inside it — opens over this page as readily as over the list, and deleting
  // the very category being looked at leaves `announce()` emitting 'change'
  // here. The section is gone, so `openCategory` toasts and reports `false`
  // with nothing repainted: the dead category's figures would stay on screen
  // over an address bar still naming it. `emit('reload')` is the recovery
  // `app.js`'s boot already performs with `dashboard.load()` for the same
  // refusal, and taking it means awaiting the answer.
  //
  // **But `false` is TWO different facts and only one of them is fatal to the
  // page**, which is why the id is asked about rather than the boolean alone.
  // `openCategory` drops `state.openCategoryId` when the category is gone and
  // keeps it when the REQUEST failed — offline, or a 500 — and there the page
  // stays put: its own toast has already said what happened, and going home
  // would throw the reader off a page that is still true to answer a question
  // the server never got to. The parentheses are explicit rather than left to
  // a reader working out that `!await f() && x` groups the way it needs to.
  on('change', async () => {
    if (state.openCategories) { open(); return; }
    const id = state.openCategoryId;
    if (id == null) return;
    const refused = !(await openCategory(id));
    if (refused && state.openCategoryId == null) emit('reload');
  });
}
