/**
 * The single-habit view: stat tiles, the strength curve, the editable
 * calendar, streaks, resilience, history and the weekday breakdowns.
 *
 * Renders into the container `views.js` hands it, so it owns no ids of its
 * own. Every control in here re-enters through `open()`.
 */

import {
  calendarChart, frequencyChart, historyChart, missDistributionChart,
  scoreChart, streakChart, survivalChart, weekdayChart, weekdayMonthChart,
} from '/shared/charts.js';
import { api } from '/shared/ui/api.js';
import { calendarWindow, weeksForWidth } from '/shared/ui/calendar.js';
import {
  card, cardInnerWidth, segmented, subheading, windowedChart,
} from '/shared/ui/components.js';
import {
  addDaysISO, formatDateShort, formatStamp, freqLabel, fromISOLocal,
  targetLabel, todayISO,
} from '/shared/ui/dates.js';
import { isAvoided } from '/shared/ui/toggle.js';
import { openDayDialog } from '/shared/ui/day-dialog.js';
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

/**
 * A card that is not being drawn holds no paging position.
 *
 * The rule the `detailCards` setting needs, and it lives HERE rather than
 * beside the setting because this file is the only one that knows which key a
 * card pages under: `windowedChart` is passed `score:<gran>` and
 * `history:<gran>` — built from the CURRENT granularity, session override
 * included — while the other two are literals, and the calendar does not use
 * `chartOffsets` at all. Written where the setting is applied, that mapping
 * would be a second copy of something already written down twice, and it would
 * have to reconstruct a granularity the settings dialog is in the middle of
 * clearing.
 *
 * Scoped to the cards actually hidden, which is the whole point. The first
 * version cleared `chartOffsets` wholesale whenever `detailCards` changed at
 * all, so unticking *Weekday consistency* also sent a History card paged back
 * to 2019 — still ticked, never hidden — back to today, with nothing on screen
 * to explain it.
 *
 * Prefix-matched for the two granular keys, so hiding the strength card forgets
 * every resolution it was paged at rather than only the one showing.
 *
 * @param {(id: string) => boolean} shows
 */
function forgetHiddenPositions(shows) {
  const owns = {
    strength: (key) => key.startsWith('score:'),
    history: (key) => key.startsWith('history:'),
    weekdayMonths: (key) => key === 'weekdayByMonth',
    frequency: (key) => key === 'frequency',
  };

  for (const [id, isOurs] of Object.entries(owns)) {
    if (shows(id)) continue;
    for (const key of Object.keys(state.chartOffsets)) {
      if (isOurs(key)) delete state.chartOffsets[key];
    }
  }

  // The calendar keeps its position in `calEnd` instead — the reason clearing
  // `chartOffsets` alone was not enough, on the one card anybody pages.
  if (!shows('calendar')) state.calEnd = null;
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
  host.replaceChildren();

  const entriesByDate = Object.fromEntries(entries.map((e) => [e.date, e.value]));

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
  h2.textContent = habit.name;
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

  // Which cards this account wants, read once — everything below the tiles is
  // gated on it. The ids are `DETAIL_CARDS` in shared/src/validate.js, which
  // the browser cannot import, so the `multi` options in ui/settings.js are the
  // second copy and test/settings.test.js is what keeps the two honest.
  //
  // The header and the four stat tiles are deliberately NOT in the list: they
  // are the summary rather than a card, so unticking everything leaves a page
  // rather than a blank one.
  const cards = new Set(settings.get('detailCards') ?? []);
  const shows = (id) => cards.has(id);
  forgetHiddenPositions(shows);

  /* score, with its own resolution selector */
  if (shows('strength')) {
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
    host.append(scoreCard);
  }

  // Built here but appended after the calendar: the calendar is the thing
  // people come to the detail view to look at and edit, so it sits directly
  // under the score rather than below two analysis cards.
  //
  // A hidden card is not BUILT, rather than built and left unappended: these
  // draw SVG, which is most of what rendering this page costs, and the setting
  // exists partly for people who do not want to wait for it.
  const streaksCard = shows('streaks')
    ? card('Best streaks',
      streakChart(stats.streaks, color, { limit: STREAK_LIMIT, width: chartWidth }))
    : null;
  const resilienceCard = shows('resilience')
    ? buildResilienceCard(stats, color, chartWidth)
    : null;

  /* calendar — clickable, with navigation back through history */
  if (shows('calendar')) {
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

    const skipSet = new Set(entries.filter((e) => e.status === 'skip').map((e) => e.date));
    const notesByDate = Object.fromEntries(
      entries.filter((e) => e.notes).map((e) => [e.date, e.notes])
    );

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
    host.append(calCard);
  }

  /* streaks, then the resilience counterweight to them */
  if (streaksCard) host.append(streaksCard);
  if (resilienceCard) host.append(resilienceCard);

  // Beside the survival curve and never instead of it. `computeSurvival` took
  // the position that "best streak: 23" is the weaker framing — a probability
  // you can act on beats a trophy — so the awards go UNDER the card holding
  // that chart rather than above it, and the chart is what answers "how far do
  // my streaks usually get" while a badge only says how far one of them got.
  const awardsCard = shows('awards') ? buildAwardsCard(stats, color) : null;
  if (awardsCard) host.append(awardsCard);

  /* history with granularity toggle */
  if (shows('history')) {
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
    host.append(histCard);
  }

  /* weekday — seven fixed bars, so nothing to page through */
  if (shows('weekdays')) {
    host.append(
      card('By day of week', weekdayChart(stats.weekdays, color,
        { width: chartWidth, weekStart: settings.get('weekStart') }))
    );
  }

  /* weekday consistency over time — the same question as the bars above,
     but keeping the month axis so drift on one weekday is visible */
  if (shows('weekdayMonths') && stats.weekdayByMonth?.length) {
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
    host.append(wmCard);
  }

  /* frequency */
  if (shows('frequency') && stats.frequency.length) {
    const fc = card('Times per week', null);
    // Months are ROWS here, so the limit is 12 rows of vertical space rather
    // than a minimum column width — but it still silently dropped older
    // months, which is the same problem the paging controls solve.
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
    host.append(fc);
  }
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
 * Returns null for a habit with nothing yet, so a brand-new one gets no empty
 * card — the same rule the resilience card follows.
 */
function buildAwardsCard(stats, color) {
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
function buildResilienceCard(stats, color, chartWidth) {
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

export function init() {
  // Nothing this view shows can be recomputed from `state` alone — the stats
  // and the entry list both come from the server — so a 'change' is a refetch
  // rather than a repaint. 'reload' is deliberately not handled: it means "go
  // to the dashboard", which is the dashboard's business.
  on('change', () => { if (state.openHabitId != null) open(state.openHabitId); });
}
