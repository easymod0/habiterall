/**
 * The single-habit view: stat tiles, the strength curve, the editable
 * calendar, streaks, resilience, history and the weekday breakdowns.
 *
 * Renders into the container `views.js` hands it, so it owns no ids of its
 * own. Every control in here re-enters through `open()`.
 */

import {
  calendarChart, frequencyChart, historyChart, MIN_STREAK, missDistributionChart,
  scoreChart, shade, streakChart, streakDates, survivalChart, weekdayChart, weekdayMonthChart,
  weekdayMonthReserve,
} from '/shared/charts.js';
import { formatAmount } from '/shared/ui/amount.js';
import { api } from '/shared/ui/api.js';
import { calendarWindow, weeksForWidth } from '/shared/ui/calendar.js';
import { syncEntry as syncCompareEntry } from '/shared/ui/categories.js';
import { convention } from '/shared/ui/count-field.js';
import {
  card, cardInnerWidth, focusKeyOf, habitIcon, restoreFocus, segmented,
  subheading, windowedChart,
} from '/shared/ui/components.js';
import {
  addDaysISO, datesEndingOn, formatDateLong, formatDateShort, formatStamp, freqLabel,
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

// Dated notes listed on the notes card, newest first. The notes are already
// all in memory (this page holds the whole unwindowed history), so this is a
// rendering choice rather than a data one — a pager could be added later with
// no change to what is fetched. See `buildNotesCard`.
const NOTES_LIMIT = 20;

/**
 * How this account spells an amount, for the head's `targetLabel`.
 *
 * Asked at the moment the label is built and never held, which is
 * `convention()`'s own rule — the setting is a fact about the ACCOUNT and
 * `auto` is a question about the DEVICE, and either can change while this
 * module is loaded. `ui/dashboard.js` declares the same one line for its row
 * and its starter presets: one expression over `count-field.js`'s single
 * `convention()`, rather than a new export here, since an export under
 * `shared/public/` costs every installed client its data cache.
 */
const showAmount = (n) => formatAmount(n, convention());

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
 * Which request for this page is the current one, and so which reply may still
 * be INSTALLED.
 *
 * The `state.categoryReadSeq` shape (`ui/store.js`), extended to the payload
 * this view draws itself from rather than restated as a second mechanism
 * beside it: a caller takes a number before its request goes out, and only a
 * reply still holding that number may `render()`. It is a counter and not a
 * timestamp for the reason stated there — two of these can start inside one
 * millisecond.
 *
 * **A separate counter from `categoryReadSeq` because it is a separate
 * question, not a second answer to that one.** `categoryReadSeq` asks which
 * view of the category LIST is newest, and three writers that say nothing
 * about a habit's stats bump it — `refreshCategoryPicker`, `moveCategory`'s
 * splice, the queued DELETE's optimistic removal. Gating a `/stats` reply on
 * it would throw a habit's page away because somebody opened the habit dialog.
 * It lives at module scope here rather than on `state` for the reason
 * `categoryReadSeq` gives for the opposite choice: that field has writers in
 * two modules and no single owner, and this one has exactly two, both in this
 * file.
 *
 * **`seed` bumps it, and that half is not optional.** It is `moveCategory`'s
 * optimistic splice in every structural respect — a write of the thing the
 * ticket protects, with no read of its own — and without it the reply that was
 * issued before the seed is still the newest and still installs. That is the
 * one-round-trip revert `refresh` does not close: `render(stale)` rebuilds the
 * head, the Edit button behind it re-captures the pre-save habit, and because
 * `PUT /habits/:id` REPLACES, one Edit-then-Save writes the newer save back
 * out. Every seed is followed by a `refresh` in the same synchronous task
 * (`init()`'s `'change'` listener is the only caller), so a reply retired by
 * one always has a newer request already promised behind it.
 */
let openSeq = 0;

/**
 * Open (or redraw) the detail view for one habit.
 *
 * Reports whether the habit ANSWERED — not whether this call is what painted
 * it. The distinction exists because a reply can be superseded (see `openSeq`
 * above), and a superseded reply has no honest answer between the two: `false`
 * would send the one caller that reads this to the dashboard over a page
 * something newer is about to draw, and "it rendered" is not true either.
 *
 * **So the boolean was narrowed rather than widened to a third state, and the
 * caller decided it.** `app.js`'s boot is the only reader —
 * `if (!await detail.open(opening.id)) await dashboard.load()` — and what it
 * is asking is "did this deep link name a habit, or am I about to show
 * nothing?"; its own comment says so ("a deleted habit's link leaves the app
 * showing nothing at all"). A discard is not that: whatever superseded this
 * call owns the screen, and it is either a newer `open()` for a habit the user
 * has since asked for or a `seed` over a page that has already rendered. So a
 * discard answers `true`, the failure path still answers `false`, and no
 * caller had to learn a third word. A third return value was the alternative
 * and it buys the one reader nothing: neither `!== 'rendered'` (paint the list
 * over the newer open) nor `=== 'failed'` (identical to this) is a better
 * answer than this one, and it would leave `detail.open` and
 * `categories.open` — the two adjacent lines of that boot — answering the same
 * question in two shapes.
 *
 * Note the values this can actually return did not move: the old code answered
 * `false` in the `catch` and `true` everywhere else, so a shell holding one
 * version of this file over a cached other version of `app.js` behaves
 * identically either way round.
 *
 * **`editDay` is the dashboard's route into the day editor, not a new export.**
 * `ui/dashboard.js`'s `listHost.editDay` calls this — already imported there as
 * `openHabit` — with `{editDay: date}`, precisely because the list holds no
 * note TEXT to seed the dialog with and this page does (see `StripHost.editDay`
 * above `detailHost`, and #224). The URL is never given the date —
 * `routes.go` above still writes only `#/habit/<id>` — because a
 * `#/habit/42/day/...` form would be a routing change reaching Android's deep
 * links, which this is not.
 *
 * @param {number} id
 * @param {{editDay?: string}} [opts]  a date to open the day editor for, once
 *   this habit has actually rendered
 * @returns {Promise<boolean>} false only when the request failed
 */
export async function open(id, { editDay } = {}) {
  // Taken before anything is awaited, so the number describes THIS request.
  const ticket = ++openSeq;

  // Every control in the detail view — zoom, calendar paging, granularity,
  // history mode — re-renders through here, and replaceChildren() drops the
  // page height to zero, which scrolls the window back to the top. Keeping
  // the position means a button press leaves you looking at the thing you
  // just pressed. Only when redrawing the *same* habit: opening a different
  // one should start at the top, as any new page would.
  const redraw = state.openHabitId === id;
  const scroll = redraw ? window.scrollY : 0;

  // Opening a different habit starts at "now". Carrying the offsets over
  // would drop you into 2024 on a habit you have only just opened. `calEnd`
  // is the calendar's own equivalent position and resets here for the same
  // reason (#274) — and `!redraw` already covers reopening the SAME habit
  // too, since `dashboard.paint()` nulls `state.openHabitId` on the way back
  // to the list, deliberately: every in-page redraw (a tap, a zoom press, a
  // granularity change, the settings dialog, the `'change'` broadcast) is
  // `redraw === true` and so keeps both positions, which is what makes
  // resetting them here affordable.
  if (!redraw) {
    state.chartOffsets = {};
    state.calEnd = null;
  }

  try {
    const stats = await api(`/habits/${id}/stats?granularity=${historyGranularity()}`);
    const entries = await api(`/habits/${id}/entries`);
    // Superseded while these were out: DISCARDED, not merely overtaken. The
    // reply is answered and drawable, and drawing it is exactly the defect —
    // History's granularity control issues DIFFERENT urls
    // (`?granularity=week` then `?granularity=month`), so an older payload
    // rendering last leaves week buckets under a control reading month with
    // nothing behind it to correct the page. The other seven in-page callers
    // send an identical url and would merely redraw the same payload, and this
    // costs them nothing: the request that superseded theirs draws it instead.
    //
    // Checked HERE and not between the two awaits. One rule, at the one moment
    // that matters — the install — rather than a second early exit whose only
    // gain is skipping an `/entries` already in flight.
    if (ticket !== openSeq) return true;
    render(stats, entries);

    if (redraw && scroll) {
      // After layout, or the page is still short and the scroll is clamped
      // to 0. Not scrollTo({behavior:'smooth'}) — this is meant to look like
      // nothing moved, not like a jump and a glide back.
      requestAnimationFrame(() => window.scrollTo(0, scroll));
    }
    // Only once this habit has actually rendered — the render above just
    // assigned the module-scope maps `detailHost.editDay` reads — and never
    // for a future date, the same refusal the calendar's own onPick already
    // makes (`isFuture`, charts.js): nothing is written about a day that has
    // not happened.
    if (editDay && editDay <= todayISO()) detailHost.editDay(id, editDay);
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
/**
 * The notes this render drew, keyed by date — out at module scope for the
 * reason the two maps above are, and now for a second one.
 *
 * It used to live only in `buildCalendarCard`'s closure, with nothing to plumb,
 * because `detailHost.edit` moved `entriesByDate` and `skipSet` alone and a
 * note could only be written through the day dialog, which refetches. The day
 * dialog's QUEUED write is what changed that: offline there is no refetch, so
 * the dialog's own optimistic edit has to move the note as well as the value,
 * or the page paints a day whose note is one edit behind. The calendar's
 * closure holds this same object, so a redraw hands `openDayDialog` the note
 * that was just written rather than the one the card was built with.
 */
let openNotesByDate = {};
/**
 * The last payload `render()` drew, so it can be redrawn from without asking
 * the server again.
 *
 * Two callers, and neither is a second source of truth: both re-render from
 * exactly the reply this page was last built with, and both are followed (or
 * accompanied) by the ordinary refetch.
 *
 * - `seed`, which redraws the head from the habit a save just stored, so the
 *   Edit button behind the dialog stops holding the pre-save one.
 * - the midnight rebuild, which needs to know WHICH local day the page on
 *   screen was drawn for — `renderedDay` below.
 *
 * @type {any} the `/habits/:id/stats` reply
 */
let lastStats = null;
/** @type {any[] | null} the `/habits/:id/entries` reply that went with it */
let lastEntries = null;
/**
 * The browser's own local date at the moment `render()` last ran.
 *
 * The device's calendar day and never a named zone — `docs/decisions/
 * timezones.md`: `resolveTimeZone` asks where an ACCOUNT is, for a reminder
 * nobody is present for, while every rendering decision on this page is the
 * question `callerDay` answers for a write. The strip draws its last column
 * from this clock, `buildRecentDaysCard`'s `draw` resolves `todayISO()`, and
 * so does `calendarChart`.
 * @type {string | null}
 */
let renderedDay = null;
/** Where the strip's cells were appended, so a repaint can find them. */
let stripRoot = null;
/**
 * The dates `render()` computed as inside a run, for `detailHost.repaint` to
 * pass back into `repaintCells` — assigned in `buildRecentDaysCard` and reset
 * to empty at the top of every `render()`, same as `stripRoot`. Kept as a
 * `Set` rather than `null` so `repaintCells`' `inRun.has(date)` never needs a
 * null guard of its own. An optimistic repaint after a tap therefore draws
 * the SAME run set the last full render built the strip from: known
 * staleness, not a bug — it is the pre-tap run set until `host.refresh()`
 * lands and a real `render()` recomputes it, exactly how the score and streak
 * tiles beside it already behave until the refetch answers.
 * @type {Set<string>}
 */
let stripRuns = new Set();
/**
 * The calendar card's own `draw`, so a repaint can redraw the grid from the
 * same maps the strip was repainted from (#230).
 *
 * A whole-card redraw rather than a `repaintCells` equivalent: `charts.js`
 * owns how a calendar cell is painted, there is no per-cell entry point into
 * it, and paging the card already costs exactly this — `draw` is what
 * ‹ Earlier / Later › / Today call. The closure holds `calCard`, which a
 * rebuild detaches, so this is assigned on every render and nulled by
 * `render()` before the rebuild for the same reason `stripRoot` is: a tap must
 * never redraw a card that is no longer on the page. Null while the account
 * has the calendar hidden, and `repaint` then has nothing to do.
 * @type {(() => void) | null}
 */
let calRedraw = null;

/**
 * The notes card's own `draw`, so a repaint can rebuild its rows from the
 * same live `openNotesByDate` a tap or an offline day-editor save has just
 * moved (#297, review round).
 *
 * Online this needed nothing: `saveDay` ends in `emit('change')`, which
 * refetches and calls `render()` wholesale. Offline `api()` enqueues and
 * throws, so that refetch never runs, and `buildNotesCard` had built its rows
 * once, from the map as it stood at render time — a cleared note left a ghost
 * row with the old text while the dot and the strip mark had both already
 * gone, and a first note on a previously-noteless day lit both marks with no
 * row to show for it. The same shape `calRedraw` exists for, one card later.
 *
 * **What this cannot cover, on purpose: a habit's FIRST offline note gets no
 * card at all until the next full `render()`.** `buildNotesCard` returns
 * `null` for a habit with no notes, so there is no card in the page for this
 * to redraw — inserting one is `render()`'s job (it owns card order from the
 * stored `detailCards` list), not a repaint's. That habit's dot and strip mark
 * still light immediately; only the card lags.
 *
 * Null while the card was never built (no notes at render time) or the
 * account has it hidden, exactly as `calRedraw`.
 * @type {(() => void) | null}
 */
let notesRedraw = null;

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
    if (!openHabit || openHabit.id !== id) {
      return { value: undefined, isSkip: false, hasNote: false };
    }
    return {
      // Whether the map HOLDS the date, never what it holds.
      value: Object.hasOwn(openEntriesByDate, date) ? openEntriesByDate[date] : undefined,
      isSkip: openSkipSet.has(date),
      hasNote: !!openNotesByDate[date],
    };
  },

  edit(id, date, to, note) {
    if (!openHabit || openHabit.id !== id) return () => {};
    // The maps THIS write is against, captured rather than named again when the
    // undo runs — and that is the whole of the rule below.
    //
    // `render()` reassigns all four bindings wholesale (one habit's maps are
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
    const notes = openNotesByDate;
    const had = Object.hasOwn(entries, date) ? entries[date] : undefined;
    const wasSkip = skips.has(date);
    const hadNote = Object.hasOwn(notes, date) ? notes[date] : undefined;

    if (to === 'clear') {
      delete entries[date];
      // The note lives ON the row, so a DELETE takes it with it — `note` is
      // not consulted here, because there is no row left for one to be
      // attached to and the refetch will report none.
      delete notes[date];
    } else {
      // `entryWrite` stores a skip as `{value: 0, status: 'skip'}`, so 0 is
      // what the refetch will report beside the status — the optimistic state
      // has to be the one that comes back, or the cell flickers on reload.
      entries[date] = to === 'skip' ? 0 : to;
      // `undefined` is "this write says nothing about the note", which is
      // every tap from a strip: `PUT /habits/:id/entries/:date` PRESERVES a
      // note it was not asked to change (root `CLAUDE.md`), so a tap must not
      // move the map either. The day dialog always states one, and an empty
      // string is a stated clear — `render()` keys this map on `e.notes` being
      // truthy, so a blank note is an ABSENT key rather than an empty one.
      if (note !== undefined) {
        if (note) notes[date] = note;
        else delete notes[date];
      }
    }
    if (to === 'skip') skips.add(date);
    else skips.delete(date);

    return () => {
      // Orphaned by a rebuild, so there is nothing here to undo: what replaced
      // these maps was read from the server, and the write being rolled back
      // never reached it. Restoring into the successor would be the corruption,
      // not the repair. One test, because `render()` assigns all four together.
      if (entries !== openEntriesByDate) return;
      if (had === undefined) delete entries[date];
      else entries[date] = had;
      if (wasSkip) skips.add(date);
      else skips.delete(date);
      if (hadNote === undefined) delete notes[date];
      else notes[date] = hadNote;
    };
  },

  // Re-runs the paint over the cells that already exist and replaces no DOM at
  // all. The dashboard's equivalent is a full `paint()`, which is cheap there;
  // here a rebuild is two requests and up to ten cards of SVG, far too much to
  // spend on a tap — and touching no nodes is also what keeps keyboard focus
  // on the button that was just pressed.
  repaint: () => {
    if (stripRoot && openHabit) repaintCells(stripRoot, detailHost, openHabit, stripRuns);
    // The calendar draws the SAME `entriesByDate` / `skipSet` the strip reads,
    // so `edit` above has already moved what it paints from — and online
    // nothing needed saying, because `writeDay` ends in `host.refresh()` and a
    // full rebuild caught the card up. OFFLINE `api()` enqueues and throws, so
    // that refetch never runs and the grid went on painting the pre-tap day
    // until the next reconnect (#230). This is the redraw that was missing, not
    // data that was; every other figure on the page is server-computed and
    // stays stale, which is the accepted staleness `stripRuns` is declared
    // with — the run bands here come from `stats.streaks`, so they redraw from
    // the same pre-tap reading the cells beside them do.
    //
    // `calRedraw` is the card's own `draw`, which READS `state.calEnd` and
    // never writes it, so a repaint draws the STORED position and commits no
    // new one (#274). Say it that way and not "the window on screen", because
    // with no stored position — the default — `draw` resolves `todayISO()`
    // afresh, and so does `calendarChart`. Left open across local midnight
    // (nothing cures that: the nudge's refresh declines while a habit is open,
    // and `'reload'` only fires offline→online) a tap therefore shifts the
    // grid a day and rewrites `.cal-range`, while `repaintCells` touches no
    // nodes and the strip keeps its pre-midnight columns. No wrong VALUE, but
    // a one-sided jump of the same shape #230 closed. Stated, not fixed.
    //
    // Cheap enough for a tap for the reason paging is: nothing in the window
    // needs a request.
    calRedraw?.();
    // The notes card's own `draw` — see the declaration above for why it
    // exists and what it deliberately cannot cover.
    notesRedraw?.();
  },

  refresh: () => refresh(openHabit?.id),

  // The secondary affordance's second half — `dayCells` wires a cell's
  // `contextmenu`/Shift+Enter to this rather than to the plain tap. This page
  // holds the whole unwindowed history, including every note's real text
  // (`openNotesByDate`), so it can open the dialog directly and seed it
  // truthfully — unlike `ui/dashboard.js`'s host, which holds only the
  // fortnight it asked for and routes through `open(id, {editDay})` instead
  // (see the `StripHost.editDay` doc above `edit`, and #224).
  editDay(id, date) {
    if (!openHabit || openHabit.id !== id) return;
    openDayDialog(
      openHabit, date, openEntriesByDate[date], openSkipSet.has(date), openNotesByDate[date],
      detailHost);
  },
};

/**
 * Reload the page, never more than once at a time.
 *
 * `open()` is two round trips and a full rebuild, so three quick taps would
 * otherwise fire three of them — and nothing guarantees the third resolves
 * last, which means a later-started reload can finish first and leave OLDER
 * data on screen. The hazard predates the strip — two fast presses on the
 * History card's ‹ Earlier, which still refetches, do it — but the strip makes
 * rapid re-entry the normal case. Note the strip's OWN ‹ Earlier no longer
 * arrives here at all (#245): it redraws locally, and a redraw with nothing to
 * fetch has no reload to race.
 *
 * A request arriving mid-flight is remembered rather than dropped: the write
 * that prompted it has already landed, so skipping the reload would leave the
 * page a version behind with nothing to trigger another.
 *
 * **`openSeq` sits underneath this and does not replace it.** The ticket says
 * which reply may be installed; this says how many requests are made and
 * guarantees one is issued after the last write. Neither implies the other —
 * without the ticket a serialised path still installs a reply the seed has
 * superseded, and without this a triple tap still spends three of the app's
 * heaviest route and leaves the last two discarded.
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

/**
 * Redraw this page from a habit a write has just stored, without waiting for
 * the refetch.
 *
 * **The window this closes.** `saveHabit` calls `dialog.close()` and then
 * `announce()`, which from a habit's own page emits `'change'`; the listener in
 * `init()` answers that with `/stats` and then `/entries` — two sequential
 * round trips, the second of them the unwindowed one — and only then does
 * `render()` run. The head's Edit button CAPTURES the habit it was drawn from,
 * so until that render lands, pressing Edit opens the dialog on the PRE-SAVE
 * habit; press Save without touching anything and, because `PUT /habits/:id`
 * REPLACES, the user's own change is written back out. That is a data loss
 * reachable by two ordinary presses, and it is what #305's flake was the test
 * suite noticing (`countcheck.mjs`).
 *
 * So the page is drawn from the reply immediately, and the refetch that follows
 * is a confirmation rather than the only source of truth. Not a gate on the
 * Edit button and not a rework of how this view gets its data: the same
 * `render()` runs, over the same payload, with one field replaced.
 *
 * **What is replaced, and what is merged.** `stats.habit` is the habit PLUS
 * `unlogged_is_success`, which `/stats` resolves per request (`unansweredCounts`,
 * server-side, because `shared/src` is not served here) and which `PUT
 * /habits/:id` does not answer with — it is response-only and in no
 * `*_HABIT_FIELDS` list. Assigning the reply wholesale would drop it, and a
 * limit whose unlogged days count as kept would lose its ghost ticks and its
 * faint calendar fills for the length of the refetch. So the reply is merged
 * OVER the habit this page was built with: every field the write answered wins,
 * and the one the write cannot speak for keeps the server's last answer — stale
 * for one round trip if the edit changed `type`, `target_type` or
 * `at_most_unlogged`, which is the same staleness every server-computed figure
 * on this page already has after an optimistic tap.
 *
 * Everything else on the payload — the score, the streaks, the history — is
 * last render's, unchanged, and is exactly what was on screen a moment ago.
 *
 * Declines unless it is looking at the same habit: `'change'` is also emitted
 * for a habit saved from the dashboard or from another habit's page, and there
 * is nothing here to seed from that.
 *
 * @param {any} habit the reply to the write, from `announce` (`habit-dialog.js`)
 */
function seed(habit) {
  if (!habit || !lastStats || !lastEntries) return;
  if (habit.id !== lastStats.habit?.id || habit.id !== state.openHabitId) return;
  // Retires every reply already out, because none of them can know about the
  // write this is painting — see `openSeq`. Bumped rather than merely drawn
  // over: `refresh` coalesces a second save into the refetch already in
  // flight, so nothing NEWER takes a ticket to supersede that reply, and
  // without this line it lands, redraws the head, and re-arms the Edit-Save
  // revert this function exists to close. The `refresh` on the line after the
  // call site is what re-asks; a seed never leaves the page with no request
  // promised behind it.
  openSeq++;
  render({ ...lastStats, habit: { ...lastStats.habit, ...habit } }, lastEntries);
}

/**
 * The page was drawn for a day that has ended — rebuild it.
 *
 * **The whole view and not the one card.** `buildRecentDaysCard`'s draw
 * resolves `todayISO()`, `buildCalendarCard`'s does, `calendarChart` recomputes
 * its own `realToday`, and every window on the page — the tiles' anchors, the
 * strip's columns, what `/stats` was asked as-of — was frozen at render time
 * the same way. Fixing one of those moves the page from "one card jumps" to
 * "one card jumps differently", which is worse than the staleness: two grids
 * over one dataset disagreeing about which day is today is indistinguishable
 * from one of them being broken.
 *
 * A REFETCH rather than a local redraw from `lastStats`, for the reason
 * `init()`'s `'change'` listener gives: nothing this view shows can be
 * recomputed from what is in hand — the score, the streaks and the history are
 * all computed as of a date the SERVER anchors from the caller's own zone
 * (`callerDay`), so a local redraw would move the columns and leave every
 * figure over them answering yesterday's question. Offline the refetch may
 * fail, and then `open()` toasts and leaves the pre-midnight page up, which is
 * the same answer every other refresh on this page gives with no network.
 */
function refreshIfDayChanged() {
  if (state.openHabitId == null || renderedDay === null) return;
  if (renderedDay === todayISO()) return;
  refresh(state.openHabitId);
}

/**
 * Ask again at the next local midnight — and on the way back to the tab.
 *
 * **Not a poll.** One timer, armed for the next local midnight and re-armed
 * from the clock each time it fires, so an open page costs one wake-up a day
 * and reads the clock once per wake. `setHours(24, 0, 0, 0)` is the start of
 * the next LOCAL day and so is DST-aware: a 23- or 25-hour calendar day gets
 * the right instant, where `+ 86400000` would be an hour out twice a year.
 *
 * **Why the timer alone is not enough, and why the pair is.** A timer is a
 * promise about the running process: a background tab clamps it to roughly one
 * a minute (harmless — it fires late, and late is still after midnight), but a
 * SUSPENDED device is not running it at all, and a laptop closed at 23:00 and
 * opened at 09:00 has no guarantee about when — or in what order — a timer
 * armed for 00:00 is delivered. `visibilitychange` is what covers exactly that
 * case, and it is the trigger that matters: the staleness costs nothing until
 * somebody LOOKS at the page, and looking at it is the event. `ui/nudge.js`
 * reaches the same conclusion for the same platform reasons, and this is a
 * separate listener from its and from `ui/connectivity.js`'s, deliberately —
 * folding unrelated concerns into one handler is how the next change to either
 * breaks the other.
 *
 * Both triggers ask `refreshIfDayChanged`, which compares the date rather than
 * trusting the schedule, so a timer that fires early (or twice) does nothing
 * and neither does a tab switch on the same day. That is also what makes this
 * right for a zone CHANGE — a laptop opened after a flight across the date line
 * is the same fact arriving by a different route.
 */
let dayTimer = 0;
function armDayWatch() {
  clearTimeout(dayTimer);
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  // A second past the boundary, so the handler cannot read `todayISO()` a
  // millisecond before the day it was armed for has actually ended.
  dayTimer = setTimeout(() => {
    dayTimer = 0;
    refreshIfDayChanged();
    armDayWatch();
  }, Math.max(1000, next.getTime() - Date.now() + 1000));
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
  // No `forget`: the notes card owns no paging position, the same reason
  // streaks/resilience/awards/weekdays omit one.
  ['notes', { build: buildNotesCard }],
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
  // ...and the comparison is not what is showing any more, however this habit
  // was reached. The two in-app rules — the comparison links to no habit, its
  // button is hidden while a habit is open — close every route the app itself
  // offers, and they cannot close a same-document fragment navigation made from
  // OUTSIDE it. The app ships one: `appLink` in `shared/src/notify.js` builds
  // `#/habit/42` for the ntfy `click` and the Discord `embed.url`, and typing
  // the fragment reaches it too. Arriving that way over `#/categories` left the
  // flag true, so Back fired `onRoute({view: 'categories'})`, `app.js`'s
  // `!state.openCategories` guard was false, `categories.open()` was skipped —
  // and the app sat with `#/categories` in the address bar and the habit still
  // rendered. This does not make `ourEntry` a real stack and does not claim to;
  // it removes the user-visible half.
  state.openCategories = false;
  // Set here rather than in `open()`, so the URL only names a habit that
  // actually rendered: `open()` is also the failure path, and a fragment
  // pointing at a habit the server refused would survive a reload as a link
  // that goes nowhere.
  routes.go({ view: 'habit', id: habit.id });
  // The top bar's Compare button goes away while a habit is open, and it is
  // `syncEntry` that decides — `openHabitId` above is one of its two inputs,
  // so this only has to say that the input moved. The rule is not cosmetic:
  // it is what makes `dashboard → habit → categories` unreachable, which is
  // what keeps `routes.js`'s single `ourEntry` boolean honest. See the note on
  // `syncEntry` in `ui/categories.js` before changing either half.
  syncCompareEntry();
  const host = views.showDetail();

  // Captured before the rebuild below destroys whatever had it. The day strip
  // is the reason this page needs it at all: a tap there refetches and rebuilds
  // every card, so without this the second tap of a cycle is unreachable from
  // a keyboard — focus drops to <body> and the next Tab starts from the top of
  // the page, which is the failure `dashboard.js` already had and fixed.
  const focused = focusKeyOf(document.activeElement);
  host.replaceChildren();
  // Nothing from the previous render survives it, and a stale node here would
  // have `repaintCells` walking an orphan — or, for `calRedraw`/`notesRedraw`,
  // appending into a card the rebuild has already detached.
  stripRoot = null;
  stripRuns = new Set();
  calRedraw = null;
  notesRedraw = null;

  const entriesByDate = Object.fromEntries(entries.map((e) => [e.date, e.value]));
  // Computed unconditionally, same as `entriesByDate` above, rather than only
  // inside the calendar's own builder: which card is `on` is decided by the
  // stored order below, so nothing this early can gate on the calendar being
  // shown, and both are cheap single passes over `entries`.
  const skipSet = new Set(entries.filter((e) => e.status === 'skip').map((e) => e.date));
  const notesByDate = Object.fromEntries(
    entries.filter((e) => e.notes).map((e) => [e.date, e.notes])
  );

  // The same four, where `detailHost` can reach them after this render has
  // returned — see the note on those declarations.
  openHabit = habit;
  openEntriesByDate = entriesByDate;
  openSkipSet = skipSet;
  openNotesByDate = notesByDate;

  // What this page was drawn FROM, so it can be drawn again without asking:
  // `seed` after a save, and the midnight rebuild. Recorded before anything is
  // appended, so a throw part-way through leaves them describing this attempt
  // rather than the render before it.
  lastStats = stats;
  lastEntries = entries;
  renderedDay = todayISO();

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
  sub.textContent = [habit.description, freqLabel(habit), targetLabel(habit, showAmount)]
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

  // One derivation, used by both cards that draw a run: the strip's faint
  // tick and the calendar's own continuation stroke. `calendarChart` also
  // recomputes `inStreak` internally from the same `streaks` array and the
  // same `MIN_STREAK`, so the two cards read the one input and cannot
  // disagree about what counts as a run — see #176.
  const inRun = streakDates(stats.streaks, MIN_STREAK);

  const ctx = {
    habit, stats, entries, color, chartWidth, entriesByDate, skipSet, notesByDate, inRun,
  };
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
 * Paging it therefore costs NO request. `draw` below is what the
 * ‹ Earlier / Later › / Now buttons call, and it rebuilds the window out of the
 * `entries` this card was handed. The dashboard holds one fortnight and must
 * ask for another, and MOST of the cards here draw figures the server computed
 * — but not all of them: `buildCalendarCard` draws from the same unwindowed
 * `entriesByDate` / `skipSet`, from `stats.streaks`, and from `calendarWindow`,
 * and its ‹ Earlier redraws locally too now, the same way — the sibling change
 * that landed as #274, not a defect still sitting open. Do not read the
 * paragraph below as saying no other card could be local.
 * What is still not request-free is BUILDING this one — the page it sits on
 * fetched twice to get here.
 *
 * Why that is worth the shape (#245): `page()` in `ui/components.js` moves
 * `state.chartOffsets` BEFORE it calls `redraw`, a GET is not replayable, and
 * `open()` toasts and returns without rendering. With `redraw` as
 * `refresh(habit.id)` a press with no network moved the position and not the
 * strip, and the window then jumped by a stride when something next drew the
 * card. Any redraw that can fail without rendering leaves those two
 * disagreeing; a local one has nothing to fail.
 *
 * What paging now shares with a tap is `inRun`: it is `render()`'s, computed
 * once per full `open()`, so a page draws its run marks from the run set the
 * card was built with — the same accepted staleness `stripRuns` is declared
 * with above, now reached by the nav buttons as well as by `repaint`.
 *
 * `windowedChart` builds into two places — the nav into `.card-head`, the
 * chart onto the card itself — which is why `draw` takes `.cal-nav` and
 * `.chart-scroll` away before building the next pair.
 */
function buildRecentDaysCard({ habit, entries, chartWidth, inRun }) {
  const strip = card('Recent days', null);
  const head = strip.querySelector('.card-head');

  const draw = () => {
    // Optional on purpose: on the first draw neither node exists, and for a
    // habit with nothing to page through `windowedChart` never builds a nav
    // at all.
    head.querySelector('.cal-nav')?.remove();
    strip.querySelector('.chart-scroll')?.remove();

    // Everything below is recomputed per draw rather than hoisted, because the
    // full rebuild this replaced recomputed all of it — `todayISO()` most of
    // all, which must not freeze at the moment the card was built.
    const todayIso = todayISO();

    // With ONE exception, stated because the line above would otherwise be read
    // as covering it: `chartWidth` is `render()`'s build-time measurement and is
    // frozen for the life of the card, so `fits` and the width handed to
    // `windowedChart` are both frozen with it. Nothing in `shared/public`
    // listens for `resize` or `orientationchange`, so every card's width already
    // only refreshes on an `open()`; what changed is that paging this one is no
    // longer one of the actions that reach `open()`, so after a desktop resize
    // or a phone rotation the strip keeps redrawing at the old width however far
    // you page, where the other cards self-correct the moment one of THEM is
    // used. Left as it is rather than re-measured here: the effect is cosmetic
    // (`.chart-scroll` absorbs the overflow) and re-measuring per draw needs a
    // second path anyway, since the card is not in the DOM on the first draw and
    // `cardInnerWidth` on a detached node answers its 720px floor.
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
      redraw: draw,
      render: (slice) => {
        const shown = settings.get('dayOrder') === 'newest-left'
          ? [...slice].reverse()
          : slice;
        const wrap = document.createElement('div');
        wrap.className = 'day-strip';
        wrap.append(
          dateColumns(shown, todayIso), dayCells(detailHost, habit, shown, todayIso, inRun));
        // Where `detailHost.repaint` looks for the cells, and the run set it
        // repaints them with. Both assigned on every render, and nulled by
        // `render()` before the rebuild, so a tap can never repaint a strip that
        // is no longer on the page.
        stripRoot = wrap;
        stripRuns = inRun;
        return wrap;
      },
    });
  };

  draw();

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
 *
 * Everything the grid draws is already in memory, the same way "Recent days"
 * is (see that card's own comment): `entriesByDate` / `skipSet` /
 * `notesByDate` come from `render()`'s unwindowed `/habits/:id/entries`
 * (`:407-413`), `stats.streaks` is already on the payload this builder was
 * handed, and `calendarWindow` (`ui/calendar.js:113`) is pure client
 * arithmetic over an end date and a week count — nothing in the window needs
 * a request. Paging therefore redraws locally through `draw` below, the same
 * shape `buildRecentDaysCard` uses: any `redraw` that can FAIL without
 * rendering leaves the stored position and the drawn window disagreeing
 * (`shared/public/CLAUDE.md`), and `open()`'s only `catch` is `toast` and a
 * `return false` — so on the occasions `open()` genuinely fails (no service
 * worker at all, a new worker claiming an open page and emptying the data
 * cache under it, a `401`/`429`, a hung server; see
 * `docs/decisions/dashboard-and-detail.md`'s `#274` section for the full
 * list, and for the two plausible-sounding cases that are NOT on it) it
 * committed `state.calEnd` and drew nothing. That was this card's own defect
 * (#274), the calendar being the second live instance of the "Recent days"
 * one (#245) fixed. It USED to
 * outlast the strip's: `open()` cleared `state.chartOffsets` when a
 * different habit was opened (`:74`) but cleared nothing for `calEnd`, so
 * paging back and returning to the dashboard left the window you never saw
 * the calendar move to waiting for you on reopen, where the strip's own
 * offset had already been reset — which is exactly why this card's defect was
 * never mostly latent the way the strip's was. Both now reset together at
 * `:74`.
 *
 * `zoom`, `CAL_WEEKS` and `chartWidth` stay hoisted and frozen for the life of
 * the card, unlike `calEnd` — `changeZoom` still ends in `open(habit.id)`
 * (a different state key, a persisted setting, and every nav button's
 * disabled state is computed from `CAL_WEEKS`, which the zoom decides), and a
 * zoom press already rebuilds the whole page, so nothing here goes stale
 * between a zoom and the next `draw()`. `chartWidth` itself is only ever
 * `render()`'s build-time measurement, though — the same one exception
 * `buildRecentDaysCard`'s own comment states in full — so a resize or a
 * rotation is not one of the things that reaches a re-measure any more:
 * this card keeps redrawing at the old width however far you page, where it
 * used to self-correct on the next `open()` that SUCCEEDED — a failed one
 * throws before `render()` and never re-measured either. Cosmetic, and left
 * as it is for the same reason the strip's is.
 */
function buildCalendarCard(
  { habit, color, chartWidth, entriesByDate, skipSet, notesByDate, stats, inRun }
) {
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

  // Removes the previous chart + legend pair and rebuilds both from
  // `state.calEnd`, exactly as `buildRecentDaysCard`'s own `draw` does.
  // Nothing below is hoisted out of it: `todayISO()` most of all, which must
  // not freeze at the moment the card was built, or paging past today would
  // stop clamping to a stale "now".
  const draw = () => {
    // Where keyboard navigation had got to, read off the grid this draw is
    // about to replace and handed to the one that replaces it (#274 / #230).
    //
    // `calendarChart` puts `tabindex="0"` on the last editable cell of every
    // build and `setRovingFocus` moves it from there as the arrows walk the
    // grid — on an attribute of nodes this line is about to remove. So every
    // rebuild used to send the tab stop back to the most recent day: paging,
    // pressing Today, and now an offline strip tap through `repaint`. Asked
    // BEFORE the removal, and of the DOM rather than of a variable, because
    // the answer is whatever the user's last arrow press left behind and
    // nothing here is told about those presses.
    //
    // Read as a DATE — see `calendarChart`'s own note on why not an index. A
    // page moves the whole window, so the date is not in the next build and
    // the last cell keeps the stop, exactly as today.
    const tabStop = calCard.querySelector('.cal-cell[tabindex="0"]')
      ?.getAttribute('data-date') ?? null;
    // Optional-chained on purpose: on the first draw neither node exists.
    calCard.querySelector('.chart-scroll')?.remove();
    calCard.querySelector('.legend')?.remove();

    const calEnd = state.calEnd ?? todayISO();
    // BOTH ends from the same window the grid below is drawn with. Left to
    // the parameter default this label named a date the calendar does not
    // start on — by a day most of the week, by six whenever the anchor falls
    // on the week's last day — and the right-hand side had the same fault
    // for the same reason: `calEnd` is the day being asked about, not the
    // last cell, so paging back drew up to six further days of real history
    // beyond the labelled end.
    //
    // Clamped to today, because the window's last column runs to the end of
    // the week and those days have not happened yet. The label says what is
    // shown and answerable; the future cells are drawn but empty.
    const calWindow = calendarWindow(calEnd, CAL_WEEKS, settings.get('weekStart'));
    const calLast = calWindow.end > todayISO() ? todayISO() : calWindow.end;
    // Written, not ISO: `2026-08-03 → 2026-09-14` under a heading that already
    // says "Completion calendar" reads as a serial number.
    //
    // Written, not ISO. Every range readout goes through one of the two
    // formatters now, including `windowedChart`'s — which used to show the
    // raw bucket key, so a card's header read `2026-07-03 → 2026-08-16` above
    // an axis saying `Jul 3, 2026`.
    navLabel.textContent =
      `${formatDateShort(fromISOLocal(calWindow.start))} → ` +
      `${formatDateShort(fromISOLocal(calLast))}`;

    const calScroll = document.createElement('div');
    calScroll.className = 'chart-scroll';
    // Held rather than passed inline, so the legend below can ask it what it
    // actually drew — see the "In a run" swatch's own comment.
    const calSvg = calendarChart(entriesByDate, color, habit, {
      zoom,
      // The account's week, which `startOfWeek` in stats.js has always
      // honoured while the calendar snapped to Sunday regardless — so the
      // heatmap and the history chart under it disagreed about where a week
      // begins.
      weekStart: settings.get('weekStart'),
      weeks: CAL_WEEKS,
      endDate: calEnd,
      skips: skipSet,
      unknownMark: settings.get('questionMarks'),
      tabStop,
      // The LIVE map, not a snapshot: `notesByDate` is mutated (see the
      // comment at this card's `calRedraw = draw` assignment below), so
      // reading it inside `draw` rather than closing over it once means an
      // offline note write is drawn on the next redraw with no refetch.
      notes: notesByDate,
      // Bands behind runs of 3+, so a good stretch reads as one thing rather
      // than a scatter of filled squares.
      streaks: stats.streaks,
      // `detailHost` rides along for the same reason `openCountDialog` is
      // handed one (`ui/day-strip.js`): two surfaces could open a day editor
      // and only the one that opened it knows where an optimistic answer goes.
      // It is what lets a QUEUED write close the dialog and repaint both grids
      // instead of leaving them asserting the pre-edit day — see `saveDay`.
      onPick: (date) => openDayDialog(
        habit, date, entriesByDate[date], skipSet.has(date), notesByDate[date], detailHost
      ),
    });
    calScroll.append(calSvg);
    calCard.append(calScroll);

    // The legend has to describe the grid above it, and for an avoided habit
    // that grid has two colours rather than a ramp — a clean day in the
    // habit's colour and a slip in red. A "Less ▢▢▢▢ More" ramp under it
    // advertises a shading the cells no longer use and shows no red at all,
    // which is the same "two surfaces over one dataset disagree" the
    // inversion exists to end.
    //
    // Rebuilt on every draw, not hoisted with the nav above it: the "In a
    // run" branch below gates on `data-run-marks`, a property of THIS
    // window, so a legend built once would go stale the moment you page.
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

    // Leading, in both branches: a fill the legend does not explain is the
    // same defect as a legend advertising a fill the cells do not use, which
    // is why the `isAvoided` branch beside it exists at all.
    // `unlogged_is_success` is the same server-resolved flag the cells above
    // read, so the legend cannot disagree with them about which habits this
    // applies to.
    if (habit.unlogged_is_success) {
      // Not `swatch(color, 0.07)` like the ramp below: `opacity` blends
      // toward the CARD, while the cell it describes blends toward
      // `--grid-empty` (`shade`, charts.js) — two different colours for the
      // same "0.07". Passing `shade(color, 0.07)` as the background is the
      // cell's own value, so the legend and the grid cannot disagree about
      // what this mark is.
      swatch(shade(color, 0.07));
      legend.append(document.createTextNode('Kept, unlogged'));
    }

    // Only when a run actually reaches an otherwise-blank cell IN THIS
    // WINDOW — `inRun` is the habit's whole history, so a run of
    // `MIN_STREAK`+ days months outside the drawn weeks (or a run made
    // entirely of logged days, where every date is in `inRun` and no cell is
    // blank) would gate this on a mark the grid does not carry.
    // `calendarChart` already counts the cells it gave the continuation
    // stroke and reports that count on the `<svg>` it returned, so asking IT
    // is the one source that cannot disagree with what is on screen —
    // recomputing the window here would be a second derivation of "which
    // cells got the mark", and a second one to keep in step with the first.
    // `getAttribute`, not `dataset`: the offline fake-DOM suites drive this
    // against a minimal `document` that implements attributes only.
    //
    // Built inline rather than through `swatch()`: that helper's second
    // argument is an opacity, blending toward the CARD, and this mark is a
    // STROKE around the cell's own `--grid-empty` fill — the same
    // distinction the "Kept, unlogged" swatch's own comment above makes, so
    // describing this one as an opacity would be the same "two surfaces
    // disagree" defect a second way. `shade(color, 0.55)` is the stroke
    // `charts.js`'s calendar block itself paints; the legend borrows the
    // cell's own value rather than writing a second description of it.
    if (Number(calSvg.getAttribute('data-run-marks')) > 0) {
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = 'var(--grid-empty)';
      sw.style.boxShadow = 'inset 0 0 0 1px ' + shade(color, 0.55);
      legend.append(sw);
      legend.append(document.createTextNode('In a run'));
    }

    // Same idiom as "In a run" just above, for the same reason: asks
    // `calendarChart` what it actually drew rather than recomputing "does
    // any date in `notesByDate` fall in this window" here, which would
    // disagree with the grid on exactly the same class of case — a note
    // months outside the drawn weeks, or a window with none in it at all. A
    // legend advertising a mark the cells do not carry is the same defect as
    // a mark the legend does not explain.
    if (Number(calSvg.getAttribute('data-note-marks')) > 0) {
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = 'var(--surface)';
      sw.style.boxShadow = 'inset 0 0 0 1px var(--text-dim)';
      sw.style.borderRadius = '50%';
      legend.append(sw);
      legend.append(document.createTextNode('Has a note'));
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
  };

  const shift = (weeks) => {
    state.calEnd = addDaysISO(state.calEnd ?? todayISO(), weeks * 7);
    if (state.calEnd > todayISO()) state.calEnd = todayISO();
    draw();
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
    mkNav('Today', 'Jump to today', () => { state.calEnd = null; draw(); }),
    zoomOut,
    zoomIn,
  );
  calHead.append(nav);

  // Where `detailHost.repaint` finds this card's redraw — assigned on every
  // render and nulled by `render()` before the rebuild, exactly as `stripRoot`
  // is, and for the same reason. Assigned once rather than inside `draw`
  // because `draw` is one closure for the life of the card; the strip's
  // equivalent is per-draw only because `windowedChart` builds a new node each
  // time and it is the NODE that is being recorded there.
  //
  // `notesByDate` is in this closure and IS mutated now, which is a correction
  // to what #230 recorded here. That note said nothing local moved it —
  // `detailHost.edit` touched `entriesByDate` and `skipSet` alone, and a note
  // could only be written through the day dialog, which refetches. The day
  // dialog's OFFLINE write is the case that was missing: there is no refetch,
  // so the dialog applies its own answer through `edit` — value, skip and note
  // together — and this redraw then hands `openDayDialog` the note that was
  // just written rather than the one the card was built with. It is the same
  // object `render()` assigned to `openNotesByDate`, so there is one map and
  // not two.
  calRedraw = draw;

  draw();

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
    // This chart's own row-label gutter is MEASURED from the localised short
    // weekday names and runs 42–103px, not the shared default's fixed 46 —
    // `scoreChart`'s and `historyChart`'s own `pad.left + pad.right`. Handing
    // `columnsForWidth` the default claimed columns whose `colW`
    // (`Math.min(72, w / shown.length)`) fell below `MIN_SLOT.circle` in seven
    // of ten sweep locales at every width, and in en-US at 408 of 1121 widths
    // measured (#285). The reserve has to come from the gutter this chart is
    // about to draw with.
    reserved: weekdayMonthReserve(chartWidth),
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
    // No `reserved` here, deliberately (#285). `frequencyChart` calls
    // `gutterFor` too, but this card's capacity is a VERTICAL row count —
    // months per row, per the comment on `buildFrequencyCard` above — and a
    // horizontal gutter cannot constrain how many rows fit. The 46 default is
    // left alone on purpose; this chart's numbers do not move.
    width: chartWidth,
    labelOf: (m) => formatStamp(m.month),
    redraw: () => open(habit.id),
    render: (slice) => frequencyChart(slice, color, { width: chartWidth }),
  });
  return fc;
}

/**
 * A habit's dated notes, newest first — so "what did I write about this
 * habit" is not a date-by-date hunt through the calendar.
 *
 * Reads `notesByDate`, the same live map `buildCalendarCard` draws its dot
 * from and `openDayDialog` seeds from (see the note on `openNotesByDate`
 * above `detailHost`) — this card owns no second copy of a note's text, and
 * nothing here decides what counts as a note. Returns null for a habit with
 * none at all, the same rule `buildResilienceCard` and `buildAwardsCard`
 * follow for their own kind of nothing.
 *
 * Capped at `NOTES_LIMIT`, newest first, with a muted line naming how many
 * earlier notes are not shown — the same shape `STREAK_LIMIT` gives the
 * streaks card, for the same reason: a cap here is a rendering choice over
 * data already in hand, not a narrower fetch, so nothing is lost by it and a
 * pager can be added later with no change to what this card is handed.
 *
 * Each row is a `<button>`, not a `<div>` with a click handler — the only one
 * of the three ways into the day editor that is keyboard-reachable by
 * construction rather than by a shortcut — and it calls `detailHost.editDay`,
 * which this page can answer truthfully because it holds the whole unwindowed
 * history, note text included.
 *
 * **The rows are rebuilt by a local `draw()`, assigned to `notesRedraw` (#297,
 * review round), for the same reason `buildCalendarCard`'s own `draw` exists:**
 * `notesByDate` is a live map an offline day-editor save mutates in place, and
 * without a redraw hook the rows painted here are frozen at build time — a
 * cleared note left a ghost row after the dot and the strip mark had both
 * gone, and a first note on a previously-noteless day lit both marks with no
 * row for it. `draw()` re-reads `notesByDate` — the same object, mutated by
 * `detailHost.edit`, never reassigned within one render's lifetime — rather
 * than a count captured when the card was built, so the "N earlier notes"
 * line cannot go on stating a number an offline edit has since moved.
 *
 * When the map has gone empty, `draw()` hides the card instead of leaving an
 * empty list, honouring the same "a card with nothing in it is hidden"
 * promise every other card here keeps — see `notesRedraw`'s own declaration
 * for the one case this cannot cover at all: a habit's FIRST offline note,
 * which gets no card until the next full `render()`, because inserting one is
 * `render()`'s job and not a repaint's.
 */
function buildNotesCard({ habit, notesByDate }) {
  if (!Object.keys(notesByDate).length) return null;

  const c = card('Notes', null);
  const list = document.createElement('div');
  list.className = 'notes-list';
  c.append(list);

  const draw = () => {
    const dates = Object.keys(notesByDate).sort().reverse();

    // The map went empty since the last draw — an offline clear of this
    // habit's only remaining note. Nothing to show and no way to insert a
    // fresh card in its place, so the existing one is hidden rather than left
    // showing an empty list.
    if (!dates.length) {
      c.hidden = true;
      return;
    }
    c.hidden = false;

    // This rebuild DROPS keyboard focus if it was on a row, and that is a
    // known gap rather than an oversight (review round 2). `repaint`'s whole
    // argument is that it touches no nodes, and the calendar's `draw` carries
    // a `tabStop` date across its own rebuild for exactly this reason — but a
    // `.note-row` carries no `data-focus-key`, so the ONLINE path already
    // loses focus here through `render()`, and this reaches the same
    // pre-existing gap by one more route rather than opening a new one.
    // Closing it properly means a focus key on the row AND a `restoreFocus`
    // in `repaint`, which today calls none — a bigger change than this card.
    list.replaceChildren();
    const shown = dates.slice(0, NOTES_LIMIT);
    for (const date of shown) {
      const d = fromISOLocal(date);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'note-row';
      row.addEventListener('click', () => detailHost.editDay(habit.id, date));

      const when = document.createElement('div');
      when.className = 'note-date';
      when.textContent = formatDateShort(d);
      when.title = formatDateLong(d);

      const text = document.createElement('div');
      text.className = 'note-text';
      // A note is user content: `textContent` only, never `innerHTML`.
      text.textContent = notesByDate[date];

      row.append(when, text);
      list.append(row);
    }

    // Removed and rebuilt rather than left to grow stale beside a rows list
    // that just moved — the count itself is exactly the thing an offline edit
    // can change. `:scope >` so this can only ever eat the line it appended
    // itself: a `.hint` added later inside a row, or in the card head, is not
    // this function's to remove and an unscoped query would take it silently.
    c.querySelector(':scope > .hint')?.remove();
    const hiddenCount = dates.length - shown.length;
    if (hiddenCount > 0) {
      const more = document.createElement('p');
      more.className = 'hint';
      more.textContent =
        `${hiddenCount} earlier note${hiddenCount === 1 ? '' : 's'} not shown.`;
      c.append(more);
    }
  };

  draw();
  // Where `detailHost.repaint` finds this card's own redraw — assigned on
  // every render, nulled by `render()` before the rebuild, same as `calRedraw`.
  notesRedraw = draw;

  return c;
}

export function init() {
  // Nothing this view shows can be recomputed from `state` alone — the stats
  // and the entry list both come from the server — so a 'change' is a refetch
  // rather than a repaint. 'reload' is deliberately not handled: it means "go
  // to the dashboard", which is the dashboard's business.
  //
  // `habit` is whatever the mutator already had in hand, and is usually
  // absent — see `emit` (`store.js`). When it is the habit a save just stored,
  // the page is redrawn from it FIRST, synchronously, because the refetch below
  // is two sequential round trips and the Edit button on screen holds the habit
  // it was drawn from for all of them. `seed` declines anything that is not
  // this habit.
  //
  // **`refresh`, not `open` — the seed is only sound if what overwrites it
  // cannot be OLDER than it.** This line called `open()` directly, which is the
  // one hazard `refresh` exists to remove: two of these in flight resolve in
  // whatever order the server answers, and `/stats` is the heaviest computed
  // route in the app. The seed is what makes two reachable, because it is what
  // puts the stored habit in the Edit box, so a second save inside the first
  // refetch is now an ordinary two presses rather than a race nobody could win
  // — and if the FIRST reply lands last, `render()` draws the pre-second-save
  // habit, the Edit button re-captures it, and one more Edit-then-Save writes
  // the second save back out. Nothing would then refetch again to correct it.
  // `refresh` never runs two, and `refreshAgain` remembers the one that arrived
  // mid-flight, so the LAST request is always issued after the last write. A
  // stale reply can still render on its way past — it is answered, and the page
  // draws what it is given — but a newer request is already promised behind it,
  // which is the difference between a page that flickers and a page that stays
  // wrong. `countcheck.mjs` forces that interleaving with CDP rather than
  // hoping for it.
  //
  // **The flicker this used to leave open is closed by `openSeq`, one level
  // up, and it was never only a flicker.** For the length of the refetch
  // `refreshAgain` promises behind a stale render, the head — and so the Edit
  // button drawn with it — held the pre-second-save habit again, which is this
  // section's own revert on a window one round trip long instead of two. What
  // the ticket had to be, and the reason it was not a rider on the `refresh`
  // change: not a counter scoped to "a reply issued before the last seed",
  // which guards this listener alone. The eight OTHER callers of `open()` —
  // the zoom press, three segmented controls and four cards' `redraw` — run
  // unserialised, and History's granularity is the one of the eight that
  // issues DIFFERENT urls, so two presses there put two
  // differently-parameterised `/stats` in flight and the older landing last
  // SETTLED the page on week buckets under a control reading month. The ticket
  // sits on `open()` itself and answers both; `seed` bumps it, which is the
  // half that reaches this listener.
  //
  // A third option was proposed here and is in the archive with its rebuttal:
  // make the SEED sticky — remember the saved habit and overlay it in
  // `render()` on an id match — which closes the revert with no reply
  // discarded. Its clearing rule is the whole of it: cleared on navigation it
  // draws this device's last save over a rename made on the phone, forever,
  // and cleared correctly it IS the generation comparison. It also says
  // nothing about which payload wins, so it could not have reached the settle
  // at all.
  on('change', (habit) => {
    if (state.openHabitId == null) return;
    seed(habit);
    refresh(state.openHabitId);
  });

  // The page is drawn for one local day, and nothing else in the app corrects
  // it: the nudge's refresh declines while a habit is open (`app.js`), and
  // `'reload'` fires only on an offline→online transition
  // (`ui/connectivity.js`). See `armDayWatch` for why this is a timer AND a
  // visibility listener rather than either alone.
  armDayWatch();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    refreshIfDayChanged();
  });
}
