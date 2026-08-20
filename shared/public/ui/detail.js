/**
 * The single-habit view: stat tiles, the strength curve, the editable
 * calendar, streaks, resilience, history and the weekday breakdowns.
 *
 * Renders into the container `views.js` hands it, so it owns no ids of its
 * own. Every control in here re-enters through `open()`.
 */

import {
  calendarChart, frequencyChart, historyChart, missDistributionChart,
  scoreChart, shade, streakChart, survivalChart, weekdayChart, weekdayMonthChart,
} from '/shared/charts.js';
import { api } from '/shared/ui/api.js';
import { calendarWindow, weeksForWidth } from '/shared/ui/calendar.js';
import {
  card, cardInnerWidth, focusKeyOf, habitIcon, restoreFocus, segmented,
  subheading, windowedChart,
} from '/shared/ui/components.js';
import {
  addDaysISO, datesEndingOn, formatDateShort, formatStamp, freqLabel,
  fromISOLocal, iso, targetLabel, todayISO,
} from '/shared/ui/dates.js';
import { isAvoided } from '/shared/ui/toggle.js';
import { openDayDialog } from '/shared/ui/day-dialog.js';
import { dateColumns, dayCells, repaintCells } from '/shared/ui/day-strip.js';
import { columnsForWidth, cappedColumns } from '/shared/ui/window.js';
import { openDialog } from '/shared/ui/habit-dialog.js';
import { resampleScores } from '/shared/ui/resample.js';
import * as routes from '/shared/ui/routes.js';
import * as settings from '/shared/ui/settings.js';
import { emit, on, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';
import * as views from '/shared/ui/views.js';

// Longest streaks listed on the detail view. They are *selected* by length
// and then *listed* newest first, so this is "how many of your best runs to
// show", not "how far down the leaderboard to go".
const STREAK_LIMIT = 10;

/**
 * The history view's bucket and mode: a session override if the per-habit
 * toggles were used, otherwise the saved default.
 *
 * Reading through these rather than `state.granularity` directly is what lets
 * the toggles be temporary — flicking to "year" to look at something should
 * not silently rewrite your preference.
 */
const historyGranularity = () => state.granularity ?? settings.get('historyGranularity');
const historyMode = () => state.historyMode ?? settings.get('historyMode');
const scoreGranularity = () => state.scoreGranularity ?? settings.get('scoreGranularity');

/**
 * Open (or redraw) the detail view for one habit.
 *
 * Reports whether it rendered. Every caller but one ignores that: the boot in
 * `app.js` opens a deep link without a list behind it, so it is the one place
 * that has to know a refused habit left nothing on screen.
 *
 * @returns {Promise<boolean>}
 */
export async function open(id) {
  // Every control in the detail view — zoom, calendar paging, granularity,
  // history mode — re-renders through here, and replaceChildren() drops the
  // page height to zero, which scrolls the window back to the top. Keeping
  // the position means a button press leaves you looking at the thing you
  // just pressed. Only when redrawing the *same* habit: opening a different
  // one should start at the top, as any new page would.
  const redraw = state.openHabitId === id;
  const scroll = redraw ? window.scrollY : 0;

  // Opening a different habit starts at "now". Carrying the offsets over
  // would drop you into 2024 on a habit you have only just opened.
  if (!redraw) state.chartOffsets = {};

  try {
    const stats = await api(`/habits/${id}/stats?granularity=${historyGranularity()}`);
    const entries = await api(`/habits/${id}/entries`);
    render(stats, entries);

    if (redraw && scroll) {
      // After layout, or the page is still short and the scroll is clamped
      // to 0. Not scrollTo({behavior:'smooth'}) — this is meant to look like
      // nothing moved, not like a jump and a glide back.
      requestAnimationFrame(() => window.scrollTo(0, scroll));
    }
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

/* ---------- the day strip's view of this page ---------- */

/**
 * How far back the strip can be paged.
 *
 * A bound, not a preference. Running from the habit's first entry looks
 * harmless until an imported row dated year 0100 asks the browser to build a
 * ~700,000-element array of days — the client-side shape of `MAX_RANGE_DAYS`
 * and the same attacker-controlled input, since a stored date is not something
 * the app chose. A year is well past what anyone answers retrospectively from a
 * strip; the calendar card is the surface for older history.
 */
const STRIP_HISTORY_DAYS = 365;

/**
 * One cell's footprint: `.check` is 44px — the minimum comfortable touch
 * target, not a look — and `.checks` puts a 4px gap between them.
 *
 * **The gap is part of the figure, and leaving it out is visible.** A density
 * is what `columnsForWidth` DIVIDES the width by, so 44 claims 23 columns fit
 * a 1026px card when 23 of them actually need 1104px: measured, the strip
 * overflowed into a horizontal scrollbar and the captions drifted up to 72px
 * off the squares they label, because `justify-content` resolves differently
 * for a row that overflows. `MIN_SLOT.circle` already carries its gap for the
 * same reason — its comment says "diameter plus a gap".
 *
 * Passed with `reserved: 0`: that parameter exists for a chart's axis labels
 * and this card has none, so the default 46 would silently cost it a column.
 */
const CELL_PX = 48;

/**
 * The page's own day maps, at module scope rather than inside `render`.
 *
 * `ui/day-strip.js`'s host has to be a singleton — the amount dialog outlives a
 * rebuild, and a host closed over one render's locals would answer from maps
 * that render has since orphaned. So the maps move out and each render
 * reassigns them; nothing reads them before the first one.
 */
let openHabit = null;
let openEntriesByDate = {};
let openSkipSet = new Set();
/** Where the strip's cells were appended, so a repaint can find them. */
let stripRoot = null;

/**
 * This page, as `ui/day-strip.js` reads and writes it.
 *
 * The encoding is `/habits/:id/entries`', which is NOT the dashboard's: a skip
 * is a row whose `status` is 'skip', carried in its own set, where `/overview`
 * flattens it onto the SKIP wire value as well. Both hosts describe the same
 * day; only their storage differs, which is the whole reason a host exists.
 *
 * @type {import('/shared/ui/day-strip.js').StripHost}
 */
const detailHost = {
  // One habit is open at a time, so a request for any other is refused rather
  // than searched for — a cell built before a different habit was opened must
  // not write into the one now showing.
  habit: (id) => (openHabit && openHabit.id === id ? openHabit : null),

  read(id, date) {
    if (!openHabit || openHabit.id !== id) return { value: undefined, isSkip: false };
    return {
      // Whether the map HOLDS the date, never what it holds.
      value: Object.hasOwn(openEntriesByDate, date) ? openEntriesByDate[date] : undefined,
      isSkip: openSkipSet.has(date),
    };
  },

  edit(id, date, to) {
    if (!openHabit || openHabit.id !== id) return () => {};
    // The maps THIS write is against, captured rather than named again when the
    // undo runs — and that is the whole of the rule below.
    //
    // `render()` reassigns all three bindings wholesale (one habit's maps are
    // never mutated into another's), so a closure over the NAMES restores into
    // whatever the page holds by the time it runs. The guard above cannot help:
    // it has already returned. Tap a cell, navigate to another habit while the
    // write is in flight, and let that write come back a real failure — a 401,
    // a 5xx, a habit deleted from another device, anything ANSWERED, since only
    // an unanswered request carries `queued` — and the rollback lands on the new
    // habit's map for a date the two share. `writeDay` repaints straight after,
    // so a cell is drawn from a value that was never this habit's, and the next
    // tap on it cycles from there and writes that back.
    //
    // Re-checking `openHabit.id === id` inside the closure is the obvious fix
    // and is not enough on its own: a `refresh()` for the SAME habit replaces
    // the maps too and passes that check. Identity of the map answers both.
    const entries = openEntriesByDate;
    const skips = openSkipSet;
    const had = Object.hasOwn(entries, date) ? entries[date] : undefined;
    const wasSkip = skips.has(date);

    if (to === 'clear') {
      delete entries[date];
    } else {
      // `entryWrite` stores a skip as `{value: 0, status: 'skip'}`, so 0 is
      // what the refetch will report beside the status — the optimistic state
      // has to be the one that comes back, or the cell flickers on reload.
      entries[date] = to === 'skip' ? 0 : to;
    }
    if (to === 'skip') skips.add(date);
    else skips.delete(date);

    return () => {
      // Orphaned by a rebuild, so there is nothing here to undo: what replaced
      // these maps was read from the server, and the write being rolled back
      // never reached it. Restoring into the successor would be the corruption,
      // not the repair. One test, because `render()` assigns the pair together.
      if (entries !== openEntriesByDate) return;
      if (had === undefined) delete entries[date];
      else entries[date] = had;
      if (wasSkip) skips.add(date);
      else skips.delete(date);
    };
  },

  // Re-runs the paint over the cells that already exist and replaces no DOM at
  // all. The dashboard's equivalent is a full `paint()`, which is cheap there;
  // here a rebuild is two requests and up to ten cards of SVG, far too much to
  // spend on a tap — and touching no nodes is also what keeps keyboard focus
  // on the button that was just pressed.
  repaint: () => {
    if (stripRoot && openHabit) repaintCells(stripRoot, detailHost, openHabit);
  },

  refresh: () => refresh(openHabit?.id),
};

/**
 * Reload the page, never more than once at a time.
 *
 * `open()` is two round trips and a full rebuild, so three quick taps would
 * otherwise fire three of them — and nothing guarantees the third resolves
 * last, which means a later-started reload can finish first and leave OLDER
 * data on screen. The hazard predates the strip (two fast presses on ‹ Earlier
 * do it) but the strip makes rapid re-entry the normal case.
 *
 * A request arriving mid-flight is remembered rather than dropped: the write
 * that prompted it has already landed, so skipping the reload would leave the
 * page a version behind with nothing to trigger another.
 */
let refreshing = null;
let refreshAgain = false;
function refresh(id) {
  if (id == null) return Promise.resolve();
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      await open(id);
    } finally {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        await refresh(id);
      }
    }
  })();
  return refreshing;
}

/** Delete every `state.chartOffsets` key a predicate matches. */
function forgetOffsets(matches) {
  for (const key of Object.keys(state.chartOffsets)) {
    if (matches(key)) delete state.chartOffsets[key];
  }
}

/**
 * Every card the detail view can draw, keyed by the id `detailCards` stores —
 * one table, in `DETAIL_CARDS` order (shared/src/validate.js, which the
 * browser cannot import; `ui/settings.js`'s `multi`/`ordered-multi` options
 * are the second declaration `test/settings.test.js` keeps honest, and this
 * is a third one only of the KEYS, not the order — `render` below draws in
 * whatever order the stored list names).
 *
 * A `Map`, not an object literal: an id comes out of storage, and
 * `CARDS['__proto__']` resolves to `Object.prototype` on a plain object —
 * `Map.prototype.get` sidesteps the question rather than needing its own
 * `Object.hasOwn` check.
 *
 * `forget` is the paging position a card owns, if it owns one at all — this
 * used to be a SECOND table here (`forgetHiddenPositions`'s `owns`), naming
 * the same nine ids for a different question. Two lists of one set of ids is
 * the trap; merging them into one entry per id is the fix. An entry with no
 * paging position (streaks, resilience, awards, weekdays) simply omits
 * `forget`.
 */
const CARDS = new Map([
  ['recentDays', {
    build: buildRecentDaysCard,
    forget: () => forgetOffsets((key) => key === 'recentDays'),
  }],
  ['strength', {
    build: buildStrengthCard,
    // Prefix-matched, so hiding the strength card forgets every resolution
    // it was ever paged at rather than only the one last showing.
    forget: () => forgetOffsets((key) => key.startsWith('score:')),
  }],
  ['calendar', {
    build: buildCalendarCard,
    // The calendar keeps its position in `calEnd` rather than
    // `chartOffsets` — the reason clearing `chartOffsets` alone was never
    // enough, on the one card anybody pages by a date rather than a window.
    forget: () => { state.calEnd = null; },
  }],
  ['streaks', { build: buildStreaksCard }],
  ['resilience', { build: buildResilienceCard }],
  ['awards', { build: buildAwardsCard }],
  ['history', {
    build: buildHistoryCard,
    forget: () => forgetOffsets((key) => key.startsWith('history:')),
  }],
  ['weekdays', { build: buildWeekdaysCard }],
  ['weekdayMonths', {
    build: buildWeekdayMonthsCard,
    forget: () => forgetOffsets((key) => key === 'weekdayByMonth'),
  }],
  ['frequency', {
    build: buildFrequencyCard,
    forget: () => forgetOffsets((key) => key === 'frequency'),
  }],
]);

/**
 * A card that is not being drawn holds no paging position.
 *
 * The rule the `detailCards` setting needs, and it lives HERE rather than
 * beside the setting because this file is the only one that knows which key a
 * card pages under: `windowedChart` is passed `score:<gran>` and
 * `history:<gran>` — built from the CURRENT granularity, session override
 * included — while the other two granular keys are literals, and the calendar
 * does not use `chartOffsets` at all. `CARDS`'s own `forget` entries are that
 * knowledge now, which is what lets this be a plain walk over the stored list
 * rather than a second table naming the ids again.
 *
 * Scoped to the cards actually hidden, which is the whole point. The first
 * version cleared `chartOffsets` wholesale whenever `detailCards` changed at
 * all, so unticking *Weekday consistency* also sent a History card paged back
 * to 2019 — still ticked, never hidden — back to today, with nothing on screen
 * to explain it.
 *
 * @param {{id: string, on: boolean}[]} cardList
 */
function forgetHiddenPositions(cardList) {
  for (const { id, on } of cardList) {
    if (!on) CARDS.get(id)?.forget?.();
  }
}

function render(stats, entries) {
  const habit = stats.habit;
  const color = habit.color;
  state.openHabitId = habit.id;
  // Set here rather than in `open()`, so the URL only names a habit that
  // actually rendered: `open()` is also the failure path, and a fragment
  // pointing at a habit the server refused would survive a reload as a link
  // that goes nowhere.
  routes.go({ view: 'habit', id: habit.id });
  const host = views.showDetail();

  // Captured before the rebuild below destroys whatever had it. The day strip
  // is the reason this page needs it at all: a tap there refetches and rebuilds
  // every card, so without this the second tap of a cycle is unreachable from
  // a keyboard — focus drops to <body> and the next Tab starts from the top of
  // the page, which is the failure `dashboard.js` already had and fixed.
  const focused = focusKeyOf(document.activeElement);
  host.replaceChildren();
  // Nothing from the previous render survives it, and a stale node here would
  // have `repaintCells` walking an orphan.
  stripRoot = null;

  const entriesByDate = Object.fromEntries(entries.map((e) => [e.date, e.value]));
  // Computed unconditionally, same as `entriesByDate` above, rather than only
  // inside the calendar's own builder: which card is `on` is decided by the
  // stored order below, so nothing this early can gate on the calendar being
  // shown, and both are cheap single passes over `entries`.
  const skipSet = new Set(entries.filter((e) => e.status === 'skip').map((e) => e.date));
  const notesByDate = Object.fromEntries(
    entries.filter((e) => e.notes).map((e) => [e.date, e.notes])
  );

  // The same three, where `detailHost` can reach them after this render has
  // returned — see the note on those declarations.
  openHabit = habit;
  openEntriesByDate = entriesByDate;
  openSkipSet = skipSet;

  /* header */
  const head = document.createElement('div');
  head.className = 'detail-head';

  const back = document.createElement('button');
  back.className = 'btn btn-sm';
  back.textContent = '← Back';
  // Announced rather than called: the dashboard owns its own loading, and
  // importing it from here would make the two views mutually dependent.
  back.addEventListener('click', () => emit('reload'));

  const titleWrap = document.createElement('div');
  titleWrap.style.flex = '1';
  const h2 = document.createElement('h2');
  const headIcon = habitIcon(habit);
  if (headIcon) h2.append(headIcon, ' ');
  h2.append(document.createTextNode(habit.name));
  const sub = document.createElement('div');
  sub.className = 'habit-sub';
  sub.textContent = [habit.description, freqLabel(habit), targetLabel(habit)]
    .filter(Boolean).join(' · ');
  titleWrap.append(h2, sub);

  const edit = document.createElement('button');
  edit.className = 'btn btn-sm';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openDialog(habit));

  head.append(back, titleWrap, edit);
  host.append(head);

  /* stat tiles */
  const tiles = document.createElement('div');
  tiles.className = 'stat-row';
  const stat = (value, label) => {
    const t = document.createElement('div');
    t.className = 'stat-tile';
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = value;
    v.style.color = color;
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = label;
    t.append(v, l);
    return t;
  };
  tiles.append(
    stat(`${Math.round(stats.score * 100)}%`, 'Strength'),
    stat(stats.currentStreak, 'Current streak'),
    stat(stats.bestStreak, 'Best streak'),
    stat(stats.totalCompleted, 'Total done'),
  );
  host.append(tiles);

  // Every chart is drawn at the width of the card it sits in, rather than at
  // a hardcoded 720px that left a third of a desktop card empty. The floor
  // keeps a phone from producing an unreadably squashed axis — below it the
  // card scrolls horizontally instead.
  const chartWidth = Math.max(320, cardInnerWidth(host));

  // Which cards this account wants, AND IN WHAT ORDER — read once, everything
  // below the tiles is gated on and ordered by this. `settings.get('detailCards')`
  // already answers the tolerant, filled-in `{id, on}[]` shape covering every
  // id in `DETAIL_CARDS` exactly once: `normalise` on the registry def
  // (ui/settings.js) is an independent mirror of `parseCardList` in
  // shared/src/validate.js, which the browser cannot import — the same reason
  // `DETAIL_CARDS` is declared twice.
  //
  // The header and the four stat tiles are deliberately NOT in the list: they
  // are the summary rather than a card, so unticking everything leaves a page
  // rather than a blank one.
  const cardList = settings.get('detailCards') ?? [];

  // Two passes over the stored list: every hidden card is forgotten FIRST,
  // then every shown card is built and appended. That is exactly what the
  // fixed source order always did — all forgetting happened before any
  // building — and it removes any question of a builder observing a later
  // card's clearing. A hidden card is still not BUILT, rather than built and
  // left unappended: these draw SVG, which is most of what rendering this
  // page costs, and the setting exists partly for people who do not want to
  // wait for it — which is why the second pass below only ever calls
  // `build` for an `on` entry.
  forgetHiddenPositions(cardList);

  const ctx = { habit, stats, entries, color, chartWidth, entriesByDate, skipSet, notesByDate };
  for (const { id, on } of cardList) {
    if (!on) continue;
    // A stored id this file does not know — an older shape, or a card since
    // removed — is skipped rather than thrown on.
    const built = CARDS.get(id)?.build?.(ctx);
    if (built) host.append(built);
  }

  restoreFocus(host, focused);
}

/**
 * The day strip: the dashboard's tappable cells, for this habit alone.
 *
 * The one card you ACT on rather than read, which is why it defaults to the top
 * of the page. Arriving here from a reminder, the only way to record the day
 * used to be the calendar card and the day editor behind it — two presses and a
 * dialog to answer a yes/no question the notification had already asked.
 *
 * Everything it draws is already in memory: `/habits/:id/entries` is fetched
 * unwindowed, so the slice a page lands on needs nothing the page does not
 * already hold. That is why it pages by SLICING where the dashboard pages by
 * asking for a different window — the dashboard holds only the fortnight it
 * requested, and no `end` parameter reaches the server from here.
 *
 * What that does NOT mean is request-free, and an earlier version of this
 * comment claimed it. `redraw` is `refresh(habit.id)` — the same full `open()`
 * every other card on this page redraws through, two round trips — so paging
 * spends a refetch to show a slice it already had. It is the page's one idiom
 * rather than this card's own bug, and it costs something visible in exactly
 * one place: offline, `page()` has already moved `state.chartOffsets` before
 * `redraw` runs, the GET is not replayable, and `open()` toasts and returns
 * without rendering. The position has moved and the strip has not, so the
 * window jumps when something next draws it. Redrawing from `entries` in hand
 * is what would make the stronger claim true; it is not what this does.
 */
function buildRecentDaysCard({ habit, entries, chartWidth }) {
  const strip = card('Recent days', null);
  const todayIso = todayISO();
  const fits = columnsForWidth(chartWidth, CELL_PX, 0);

  // How far back there is to page. Trimmed by comparing ISO strings against
  // the habit's first entry rather than by counting days between two dates:
  // the count is the thing this repo has got wrong twice (an epoch walk
  // repeats a day under a fall-back transition, calendar arithmetic emits a
  // day Apia never lived), and none of it is needed to answer "which of these
  // days predate the habit".
  //
  // `entries` is ordered by date, so `[0]` is the earliest. Never fewer than
  // one screenful, so a habit with no history at all still gets a full,
  // tappable strip — which is exactly who this card is for.
  const all = datesEndingOn(STRIP_HISTORY_DAYS, todayIso);
  const first = entries.length ? entries[0].date : todayIso;
  const firstIdx = all.findIndex((d) => iso(d) >= first);
  const dates = all.slice(Math.min(
    firstIdx === -1 ? all.length : firstIdx,
    Math.max(0, all.length - fits)
  ));

  windowedChart({
    card: strip,
    key: 'recentDays',
    items: dates,
    density: CELL_PX,
    // The account's `gridDays`, capping what the card's width allows — the
    // setting means "at most this many days of grid" on both surfaces. The
    // ladder `gridColumns` applies is NOT used here: it exists to protect the
    // habit name beside the dashboard's cells, and this card has no name
    // column.
    capacity: cappedColumns(settings.get('gridDays'), fits),
    width: chartWidth,
    labelOf: (d) => formatDateShort(d),
    redraw: () => refresh(habit.id),
    render: (slice) => {
      const shown = settings.get('dayOrder') === 'newest-left'
        ? [...slice].reverse()
        : slice;
      const wrap = document.createElement('div');
      wrap.className = 'day-strip';
      wrap.append(dateColumns(shown, todayIso), dayCells(detailHost, habit, shown, todayIso));
      // Where `detailHost.repaint` looks for the cells. Assigned on every
      // render, and nulled by `render()` before the rebuild, so a tap can never
      // repaint a strip that is no longer on the page.
      stripRoot = wrap;
      return wrap;
    },
  });

  // Never null, unlike the cards that decline when they have no data: a habit
  // with no history at all is exactly who this card is for.
  return strip;
}

/**
 * The score card: the strength curve, with its own resolution selector.
 */
function buildStrengthCard({ habit, stats, color, chartWidth }) {
  const scoreCard = card('Habit strength', null);
  const scoreHead = scoreCard.querySelector('.card-head');
  scoreHead.append(segmented(
    ['day', 'week', 'month', 'quarter', 'year'],
    scoreGranularity(),
    async (g) => { state.scoreGranularity = g; await open(habit.id); }
  ));

  // The score is computed daily whatever this says — it is an EWMA, so
  // skipping days would change the value rather than the resolution. The
  // selector only thins out which points are plotted.
  const scorePoints =
    resampleScores(stats.scores, scoreGranularity(), settings.get('weekStart'));

  windowedChart({
    card: scoreCard,
    key: `score:${scoreGranularity()}`,
    items: scorePoints,
    // A line chart stays readable at far tighter spacing than bars do, so it
    // only pages once the vertices would overlap.
    density: 'point',
    width: chartWidth,
    labelOf: (p) => formatStamp(p.date),
    redraw: () => open(habit.id),
    render: (slice) => scoreChart(slice, color, { width: chartWidth }),
  });
  return scoreCard;
}

/**
 * The calendar — clickable, with navigation back through history and its own
 * zoom, independent of the account's saved default for the length of this
 * viewing.
 *
 * The thing people come to the detail view to look at and edit, which is why
 * the `detailCards` DEFAULT (ui/settings.js) puts it immediately after
 * `strength` — directly under the score rather than below two analysis
 * cards. That is a fact about the default order now, not about where this
 * builder is called from: `test/settings.test.js`'s adjacency assertion pins
 * it, and any account is free to move it.
 */
function buildCalendarCard({ habit, color, chartWidth, entriesByDate, skipSet, notesByDate, stats }) {
  const calCard = card('Calendar', null);
  const calHead = calCard.querySelector('.card-head');

  const nav = document.createElement('div');
  nav.className = 'cal-nav';
  const navLabel = document.createElement('span');
  navLabel.className = 'cal-range';

  const mkNav = (text, label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    return b;
  };

  // Zoom comes from the saved setting, but the buttons below change it for
  // this session too, so trying a level does not mean a trip to Settings.
  const ZOOM_ORDER = ['closest', 'close', 'default', 'wide'];
  const zoom = state.calZoom ?? settings.get('calendarZoom');

  // Fill the card rather than sitting at a fixed width with empty space to the
  // right of it. `chartWidth` is measured from the container the card is about
  // to be appended to, since calCard is not in the DOM yet.
  const CAL_WEEKS = weeksForWidth(chartWidth, zoom);

  const shift = (weeks) => {
    state.calEnd = addDaysISO(state.calEnd ?? todayISO(), weeks * 7);
    if (state.calEnd > todayISO()) state.calEnd = todayISO();
    open(habit.id);
  };

  /** @param {number} dir -1 zooms in (bigger squares), +1 zooms out */
  const changeZoom = (dir) => {
    const i = ZOOM_ORDER.indexOf(zoom);
    const next = ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, Math.max(0, i + dir))];
    if (next === zoom) return;
    state.calZoom = next;
    // `set` is synchronous and owns its own offline queuing, so the redraw
    // never waits on the server.
    settings.set('calendarZoom', next);
    open(habit.id);
  };

  const zoomIn = mkNav('+', 'Zoom in: bigger squares, less history', () => changeZoom(-1));
  const zoomOut = mkNav('−', 'Zoom out: smaller squares, more history', () => changeZoom(1));
  zoomIn.disabled = zoom === ZOOM_ORDER[0];
  zoomOut.disabled = zoom === ZOOM_ORDER.at(-1);

  nav.append(
    mkNav('‹ Earlier', 'Show earlier months', () => shift(-CAL_WEEKS)),
    navLabel,
    mkNav('Later ›', 'Show later months', () => shift(CAL_WEEKS)),
    mkNav('Today', 'Jump to today', () => { state.calEnd = null; open(habit.id); }),
    zoomOut,
    zoomIn,
  );
  calHead.append(nav);

  const calEnd = state.calEnd ?? todayISO();
  // BOTH ends from the same window the grid below is drawn with. Left to the
  // parameter default this label named a date the calendar does not start on —
  // by a day most of the week, by six whenever the anchor falls on the week's
  // last day — and the right-hand side had the same fault for the same reason:
  // `calEnd` is the day being asked about, not the last cell, so paging back
  // drew up to six further days of real history beyond the labelled end.
  //
  // Clamped to today, because the window's last column runs to the end of the
  // week and those days have not happened yet. The label says what is shown
  // and answerable; the future cells are drawn but empty.
  const calWindow = calendarWindow(calEnd, CAL_WEEKS, settings.get('weekStart'));
  const calLast = calWindow.end > todayISO() ? todayISO() : calWindow.end;
  // Written, not ISO: `2026-08-03 → 2026-09-14` under a heading that already
  // says "Completion calendar" reads as a serial number.
  //
  // Written, not ISO. Every range readout goes through one of the two
  // formatters now, including `windowedChart`'s — which used to show the raw
  // bucket key, so a card's header read `2026-07-03 → 2026-08-16` above an axis
  // saying `Jul 3, 2026`.
  navLabel.textContent =
    `${formatDateShort(fromISOLocal(calWindow.start))} → ` +
    `${formatDateShort(fromISOLocal(calLast))}`;

  const calScroll = document.createElement('div');
  calScroll.className = 'chart-scroll';
  calScroll.append(calendarChart(entriesByDate, color, habit, {
    zoom,
    // The account's week, which `startOfWeek` in stats.js has always honoured
    // while the calendar snapped to Sunday regardless — so the heatmap and the
    // history chart under it disagreed about where a week begins.
    weekStart: settings.get('weekStart'),
    weeks: CAL_WEEKS,
    endDate: calEnd,
    skips: skipSet,
    unknownMark: settings.get('questionMarks'),
    // Bands behind runs of 3+, so a good stretch reads as one thing rather
    // than a scatter of filled squares.
    streaks: stats.streaks,
    onPick: (date) => openDayDialog(
      habit, date, entriesByDate[date], skipSet.has(date), notesByDate[date]
    ),
  }));
  calCard.append(calScroll);

  // The legend has to describe the grid above it, and for an avoided habit that
  // grid has two colours rather than a ramp — a clean day in the habit's colour
  // and a slip in red. A "Less ▢▢▢▢ More" ramp under it advertises a shading
  // the cells no longer use and shows no red at all, which is the same "two
  // surfaces over one dataset disagree" the inversion exists to end.
  const legend = document.createElement('div');
  legend.className = 'legend';
  const swatch = (background, opacity) => {
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.background = background;
    if (opacity != null) sw.style.opacity = String(opacity);
    legend.append(sw);
    return sw;
  };

  // Leading, in both branches: a fill the legend does not explain is the same
  // defect as a legend advertising a fill the cells do not use, which is why
  // the `isAvoided` branch beside it exists at all. `unlogged_is_success` is
  // the same server-resolved flag the cells above read, so the legend cannot
  // disagree with them about which habits this applies to.
  if (habit.unlogged_is_success) {
    // Not `swatch(color, 0.07)` like the ramp below: `opacity` blends toward
    // the CARD, while the cell it describes blends toward `--grid-empty`
    // (`shade`, charts.js) — two different colours for the same "0.07".
    // Passing `shade(color, 0.07)` as the background is the cell's own value,
    // so the legend and the grid cannot disagree about what this mark is.
    swatch(shade(color, 0.07));
    legend.append(document.createTextNode('Kept, unlogged'));
  }

  if (isAvoided(habit)) {
    legend.append(document.createTextNode('Clean'));
    swatch(color);
    swatch('var(--danger)');
    legend.append(document.createTextNode('Slipped'));
  } else {
    legend.append(document.createTextNode('Less'));
    for (const t of [0.2, 0.45, 0.7, 1]) swatch(color, t);
    legend.append(document.createTextNode('More'));
  }
  calCard.append(legend);
  return calCard;
}

/** Longest streaks, newest first, up to `STREAK_LIMIT` of them. */
function buildStreaksCard({ stats, color, chartWidth }) {
  return card('Best streaks',
    streakChart(stats.streaks, color, { limit: STREAK_LIMIT, width: chartWidth }));
}

/**
 * "Bouncing back": recovery rate, how long lapses last, and how far streaks
 * usually get.
 *
 * These three answer the question streaks and the score curve do not — when
 * this habit fails, what happens next? A long best-streak says you once had a
 * good month; recovery rate says whether one bad day tends to become a bad
 * week, which is what actually decides whether a habit survives.
 *
 * Returns null when there is nothing honest to say: a non-daily habit (where
 * off-days are not failures) or a habit with no history yet.
 */
function buildResilienceCard({ stats, color, chartWidth }) {
  const r = stats.resilience;
  if (!r || !r.applicable) return null;

  const hasLapses = r.recovery.lapses > 0 || r.recovery.openRun > 0;
  const hasStreaks = r.survival.length > 0;
  // A brand-new habit has neither, and three empty charts say nothing.
  if (!hasLapses && !hasStreaks) return null;

  const c = card('Bouncing back', null);

  const lead = document.createElement('p');
  lead.className = 'hint';
  lead.textContent =
    'Streaks show your best run. These show what happens after a miss.';
  c.append(lead);

  /* headline figures */
  const tiles = document.createElement('div');
  tiles.className = 'stat-row';

  const tile = (value, label, tone) => {
    const t = document.createElement('div');
    t.className = 'stat-tile';
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = value;
    v.style.color = tone ?? color;
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = label;
    t.append(v, l);
    return t;
  };

  // A null rate means nothing has ever been missed — which is not the same
  // claim as "recovers 100% of the time", so it must not render as a number.
  tiles.append(tile(
    r.recovery.rate == null ? '—' : `${Math.round(r.recovery.rate * 100)}%`,
    r.recovery.rate == null ? 'No misses yet' : 'Back next day'
  ));
  tiles.append(tile(
    r.worstLapse ? `${r.worstLapse}d` : '—',
    'Longest lapse'
  ));
  if (r.recovery.openRun > 0) {
    tiles.append(tile(`${r.recovery.openRun}d`, 'Currently missed',
      'var(--danger, #ef4444)'));
  }
  c.append(tiles);

  if (r.recovery.rate != null) {
    const summary = document.createElement('p');
    summary.className = 'hint';
    summary.textContent =
      `After a miss you were back the next day ${r.recovery.recovered} of ` +
      `${r.recovery.lapses} time${r.recovery.lapses === 1 ? '' : 's'}.`;
    c.append(summary);
  }

  if (hasLapses) {
    c.append(subheading('How long lapses last'));
    const scroll = document.createElement('div');
    scroll.className = 'chart-scroll';
    scroll.append(missDistributionChart(r.missDistribution, color, { width: chartWidth }));
    c.append(scroll);
  }

  if (hasStreaks) {
    c.append(subheading('How far streaks get'));
    const scroll = document.createElement('div');
    scroll.className = 'chart-scroll';
    scroll.append(survivalChart(r.survival, color, { width: chartWidth }));
    c.append(scroll);

    const first = r.survival.find((p) => p.days >= 7) ?? r.survival[r.survival.length - 1];
    if (first) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent =
        `${Math.round(first.share * 100)}% of your streaks reached ${first.days} days.`;
      c.append(note);
    }
  }

  return c;
}

/**
 * The awards row: the server's reading of the figures already on this page.
 *
 * Rendered, never decided. Which awards exist and what they are called is
 * `shared/src/awards.js` — the ladder they are read off (`SURVIVAL_THRESHOLDS`)
 * lives in `stats.js`, which the browser cannot import, and a second copy of it
 * here is exactly the drift the issue asked for it to be reused to avoid. So
 * the client's whole job is the styling, and it keeps no judgement at all: an
 * earlier version drew two shapes from a `permanent` flag, which claimed some
 * awards could not be taken away. None of them can promise that — the window
 * every figure is computed over moves — so the flag is gone and with it the
 * second shape. The lead paragraph says what these are instead, which is the
 * honest place for it.
 *
 * `computeSurvival` took the position that "best streak: 23" is the weaker
 * framing — a probability you can act on beats a trophy — which is why the
 * `detailCards` DEFAULT (ui/settings.js) puts awards after resilience rather
 * than above it: the survival chart answers "how far do my streaks usually
 * get" and a badge only says how far one of them got. That is a fact about the
 * default order now, not about where this card is appended from;
 * `test/settings.test.js`'s adjacency assertion pins it, and any account is
 * free to move it.
 *
 * Returns null for a habit with nothing yet, so a brand-new one gets no empty
 * card — the same rule the resilience card follows.
 */
function buildAwardsCard({ stats, color }) {
  // `?? []` and not a guard on the key: an offline boot can serve a stats
  // response the service worker cached before this shipped.
  const awards = stats.awards ?? [];
  if (!awards.length) return null;

  const c = card('Awards', null);

  const lead = document.createElement('p');
  lead.className = 'hint';
  // Says what these are, in the one place a reader will look. Nothing is
  // stored, so each of these is a reading of the history as it stands — which
  // means it can change when the history does, including backwards.
  lead.textContent =
    'What this habit’s history shows right now. These are worked out from '
    + 'your entries each time rather than stored, so they move as the history '
    + 'does.';
  c.append(lead);

  const row = document.createElement('div');
  row.className = 'award-row';

  for (const a of awards) {
    const el = document.createElement('div');
    el.className = 'award';
    // The habit's own colour, as every other figure on this page uses. A
    // custom property rather than a border colour directly, so the stylesheet
    // decides which edges take it — and so nothing here has to know that the
    // one element with text ON a fill deliberately does not.
    el.style.setProperty('--award-accent', color);
    el.setAttribute('data-award', a.id);

    const label = document.createElement('div');
    label.className = 'award-label';
    label.textContent = a.label;

    if (a.fresh) {
      const flag = document.createElement('span');
      flag.className = 'award-fresh';
      // A comeback is the one thing here with a moment, and deriving on every
      // request has no other way to give it one.
      flag.textContent = 'New';
      label.append(' ', flag);
    }

    const detail = document.createElement('div');
    detail.className = 'award-detail';
    detail.textContent = a.detail;

    el.append(label, detail);
    row.append(el);
  }

  c.append(row);
  return c;
}

/** History with its granularity and percent-vs-count toggles. */
function buildHistoryCard({ habit, stats, color, chartWidth }) {
  const histCard = card('History', null);
  const histHead = histCard.querySelector('.card-head');

  const gran = segmented(
    ['day', 'week', 'month', 'quarter', 'year'],
    historyGranularity(),
    async (g) => { state.granularity = g; await open(habit.id); }
  );
  const mode = segmented(
    ['percent', 'count'],
    historyMode(),
    async (m) => { state.historyMode = m; await open(habit.id); }
  );
  const toggles = document.createElement('div');
  toggles.style.display = 'flex';
  toggles.style.gap = '8px';
  toggles.style.flexWrap = 'wrap';
  toggles.append(gran, mode);
  histHead.append(toggles);

  windowedChart({
    card: histCard,
    key: `history:${historyGranularity()}`,   // per bucket: 60 weeks ≠ 60 days
    items: stats.history,
    density: 'bar',
    width: chartWidth,
    labelOf: (b) => formatStamp(b.bucket),
    redraw: () => open(habit.id),
    render: (slice) => historyChart(slice, color, {
      showPercent: historyMode() === 'percent',
      width: chartWidth,
    }),
  });
  return histCard;
}

/** Seven fixed bars, so nothing to page through. */
function buildWeekdaysCard({ stats, color, chartWidth }) {
  return card('By day of week', weekdayChart(stats.weekdays, color,
    { width: chartWidth, weekStart: settings.get('weekStart') }));
}

/**
 * Weekday consistency over time — the same question as the bars above, but
 * keeping the month axis so drift on one weekday is visible.
 *
 * Returns null with too little history to plot a month axis at all — the
 * guard that used to sit in the `if` this card was appended inside.
 */
function buildWeekdayMonthsCard({ habit, stats, color, chartWidth }) {
  if (!stats.weekdayByMonth?.length) return null;

  const wmCard = card('Weekday consistency', null);
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'Bigger circles mean a higher completion rate. A row that fades to the '
    + 'right is a weekday you have been losing.';
  wmCard.append(hint);
  windowedChart({
    card: wmCard,
    key: 'weekdayByMonth',
    items: stats.weekdayByMonth,
    density: 'circle',
    width: chartWidth,
    labelOf: (m) => formatStamp(m.month),
    redraw: () => open(habit.id),
    render: (slice) => weekdayMonthChart(slice, color,
      { width: chartWidth, weekStart: settings.get('weekStart') }),
  });
  return wmCard;
}

/**
 * Months per row, so the limit is vertical space rather than a minimum column
 * width — but it still needs paging, or it silently drops older months.
 *
 * Returns null with no frequency data at all — the guard that used to sit in
 * the `if` this card was appended inside.
 */
function buildFrequencyCard({ habit, stats, color, chartWidth }) {
  if (!stats.frequency.length) return null;

  const fc = card('Times per week', null);
  windowedChart({
    card: fc,
    key: 'frequency',
    items: stats.frequency,
    density: 60,   // ~12 rows on a typical card
    width: chartWidth,
    labelOf: (m) => formatStamp(m.month),
    redraw: () => open(habit.id),
    render: (slice) => frequencyChart(slice, color, { width: chartWidth }),
  });
  return fc;
}

export function init() {
  // Nothing this view shows can be recomputed from `state` alone — the stats
  // and the entry list both come from the server — so a 'change' is a refetch
  // rather than a repaint. 'reload' is deliberately not handled: it means "go
  // to the dashboard", which is the dashboard's business.
  on('change', () => { if (state.openHabitId != null) open(state.openHabitId); });
}
