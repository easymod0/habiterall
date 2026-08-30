/**
 * Minimal SVG chart helpers. Hand-rolled rather than pulled from a library so
 * the app ships with no frontend build step and no CDN dependency.
 */

// Relative, not '/shared/...': two test suites import this module directly in
// Node, where a root-absolute specifier resolves against the filesystem root.
// A relative path works in both the browser and Node.
import {
  calendarWindow, weekdayIndex, zoomLevel, calendarWidth, CALENDAR_PAD_LEFT,
  DEFAULT_ZOOM,
} from './ui/calendar.js';
import { SKIP, YES } from './ui/values.js';
// Relative, like the two above, and for the same reason: two suites import this
// module in Node. Neither reaches for anything but `Date`, `Intl` and its own
// constants, which is what keeps them loadable under the fake DOM.
import {
  WIDTH_SAFETY, estimateTextWidth, formatDateShort, formatStamp, fromISOLocal,
  addDaysISO, formatDayRange, formatMonthShort, formatYear, gutterFor, iso,
  weekdayLetters,
  weekdayNames,
} from './ui/dates.js';
import { isAvoided } from './ui/toggle.js';

const NS = 'http://www.w3.org/2000/svg';

/** Shorter runs are noise, not an achievement. */
export const MIN_STREAK = 3;

/**
 * The seven `getDay()` indices in the order the rows are drawn.
 *
 * Sunday-start is the identity; Monday-start is `[1..6, 0]`. Everything with a
 * weekday axis reads BOTH its labels and its data through this, which is the
 * point: the stats functions index days by `getDay()`, so rotating the captions
 * alone would caption Monday's row "Su" and leave the bars where they were —
 * a chart that is wrong in the one dimension it exists to show.
 */
const weekOrder = (weekStart) =>
  weekStart === 'monday' ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];

/** Those labels in row order. */
const rotateWeek = (labels, weekStart) =>
  weekOrder(weekStart).map((i) => labels[i]);

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function svgRoot(width, height) {
  const svg = el('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
  });
  return svg;
}

/**
 * A theme colour, as a reference CSS resolves rather than a value read now.
 *
 * These used to be read with `getComputedStyle` at draw time and written into
 * the `fill` attribute as a literal — which freezes the palette the chart was
 * drawn under. An SVG attribute does not follow the theme, and the only thing
 * that can correct it is a re-render; for the detail view a re-render is a
 * REFETCH, so switching to dark left every unrecorded calendar square holding
 * the light `#e6e9ef` — near-white against the dark card — for two requests,
 * and permanently if either failed. Reported as "the blank squares are
 * sometimes white until I refresh".
 *
 * A `var()` in a presentation attribute is a live reference: the same square
 * now follows the theme with no redraw, no request, and nothing to go stale.
 */
const themed = (name) => `var(${name})`;

/**
 * Blend a hex colour toward the empty-cell colour by `t` (0 = empty, 1 = full).
 *
 * `color-mix` for the same reason as [themed] — the blend used to be computed
 * in JS against whichever palette was current, which baked the answer in. The
 * blend was always toward `--grid-empty` (its two literals were that variable's
 * two values), so this is the same arithmetic with the second colour left for
 * CSS to resolve. `t >= 1` returns the colour itself: a mix with nothing to mix
 * is noise in the DOM, and the habit's own colour is not a theme colour.
 */
export function shade(hex, t) {
  if (t >= 1) return hex;
  return `color-mix(in srgb, ${hex} ${Math.round(t * 100)}%, var(--grid-empty))`;
}

function title(node, text) {
  node.appendChild(el('title', {}, text));
  return node;
}

/* ---------- score line chart ---------- */

export function scoreChart(scores, color, { width = 720, height = 200 } = {}) {
  const pad = { top: 12, right: 12, bottom: 24, left: 34 };
  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Habit strength over time');

  if (!scores.length) return svg;

  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const dim = themed('--text-dim');
  const border = themed('--border');

  const x = (i) => pad.left + (scores.length === 1 ? w / 2 : (i / (scores.length - 1)) * w);
  const y = (v) => pad.top + h - v * h;

  // horizontal gridlines at 0 / 50 / 100%
  for (const frac of [0, 0.5, 1]) {
    svg.appendChild(el('line', {
      x1: pad.left, x2: width - pad.right, y1: y(frac), y2: y(frac),
      stroke: border, 'stroke-width': 1,
    }));
    svg.appendChild(el('text', {
      x: pad.left - 6, y: y(frac) + 4, 'text-anchor': 'end',
      'font-size': 10, fill: dim,
    }, `${Math.round(frac * 100)}%`));
  }

  const line = scores.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(s.score).toFixed(2)}`).join(' ');
  const area = `${line} L${x(scores.length - 1).toFixed(2)},${y(0)} L${x(0).toFixed(2)},${y(0)} Z`;

  const gradId = `grad-${Math.random().toString(36).slice(2, 9)}`;
  const defs = el('defs');
  const grad = el('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.35 }));
  grad.appendChild(el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  svg.appendChild(el('path', { d: area, fill: `url(#${gradId})` }));
  svg.appendChild(el('path', {
    d: line, fill: 'none', stroke: color,
    'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // Date labels at both ends, written the way the rest of the app writes a
  // date. These were raw ISO, which under a heading that already says what the
  // chart is reads as machine output — and it was English-neutral only by
  // accident, since the two hardcoded month arrays beside it were not.
  const axisDate = (isoDate) => formatDateShort(fromISOLocal(isoDate));
  svg.appendChild(el('text', {
    x: pad.left, y: height - 6, 'font-size': 10, fill: dim,
  }, axisDate(scores[0].date)));
  svg.appendChild(el('text', {
    x: width - pad.right, y: height - 6, 'text-anchor': 'end',
    'font-size': 10, fill: dim,
  }, axisDate(scores[scores.length - 1].date)));

  return svg;
}

/* ---------- calendar heatmap ---------- */

export function calendarChart(entriesByDate, color, habit, opts = {}) {
  const {
    zoom = DEFAULT_ZOOM, // 'close' | 'default' | 'wide'
    endDate = null,     // last date shown; defaults to today
    skips = null,       // Set of skipped dates, kept out of the value space
    onPick = null,      // callback(date) -> makes cells clickable
    streaks = null,     // [{start, end, length}] to underline as runs
    minStreak = MIN_STREAK,
    unknownMark = false, // draw '?' on days with no entry (`questionMarks`)
    weekStart = 'monday', // which day a column begins on
  } = opts;

  const level = zoomLevel(zoom);
  // An explicit `weeks` still wins, so a caller can size the grid itself.
  const weeks = opts.weeks ?? level.weeks;
  const CELL = level.cell;
  const GAP = level.gap;
  const step = CELL + GAP;
  const padLeft = CALENDAR_PAD_LEFT;
  const padTop = 16;

  // calendarWidth, not padLeft + weeks*step: the last column needs no trailing
  // gap, and that one extra pixel-gap was enough to trip `max-width: 100%`
  // into scaling the whole grid down.
  const width = calendarWidth(weeks, zoom);
  // The extra 4px at the foot leaves room for the wrap tab hanging below the
  // week's LAST row; the one above its first sits inside padTop's existing
  // space. Which weekday those are depends on `weekStart` — the rows are
  // positional — so they are named by position here rather than by day.
  const height = padTop + 7 * step + 4;
  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Completion calendar');

  const dim = themed('--text-dim');
  const empty = themed('--grid-empty');


  const realToday = new Date();
  realToday.setHours(0, 0, 0, 0);
  const todayISO = iso(realToday);

  // The grid ends on `endDate` (or today) and runs `weeks` back from there.
  const last = endDate ? fromISOLocal(endDate) : new Date(realToday);
  last.setHours(0, 0, 0, 0);

  // The window is anchored on its end so `last` is always drawn — see
  // calendarWindow, where the reasoning and the regression test live.
  const start = fromISOLocal(calendarWindow(iso(last), weeks, weekStart).start);

  // Two labels, at the first and third rows. They move with the setting: the
  // grid's rows are positional — row 0 is whatever `calendarWindow` started the
  // week on — so a fixed 'S' over row 0 captions Monday on a Monday-start week.
  const calLabels = rotateWeek(weekdayLetters(), weekStart);
  for (let i = 0; i < 3; i += 2) {
    svg.appendChild(el('text', {
      x: 0, y: padTop + (i * step) + CELL - 2, 'font-size': 9, fill: dim,
    }, calLabels[i]));
  }

  // Dates belonging to a streak worth showing, so each cell can decide
  // whether to merge with its neighbours. A Set rather than a per-cell scan
  // of the streak list: at wide zoom that would be ~740 cells x every streak.
  const inStreak = streakDates(streaks, minStreak);

  // Connectors are drawn in their own pass BEFORE the cells, because SVG
  // paints in document order and they must sit underneath. A separate sweep
  // rather than insertBefore: the offline render tests use a fake DOM with
  // only appendChild, and this needs nothing more.
  if (inStreak.size) {
    const link = shade(color, 1);
    const thick = Math.max(2, CELL * 0.34);
    const probe = new Date(start);

    for (let wk = 0; wk < weeks; wk++) {
      for (let dow = 0; dow < 7; dow++) {
        const date = iso(probe);
        probe.setDate(probe.getDate() + 1);
        if (!inStreak.has(date) || !inStreak.has(addDaysISO(date, 1))) continue;

        const x = padLeft + wk * step;
        const y = padTop + dow * step;

        if (dow < 6) {
          // Within a column: a short bar bridging the gap to the day below.
          svg.appendChild(el('rect', {
            // Inset from the cell's sides so it reads as a link between
            // squares rather than widening them into a solid block.
            x: x + (CELL - thick) / 2,
            y: y + CELL - 0.5,
            width: thick,
            height: GAP + 1,
            fill: link,
            // Names the date this connector is FOR, the same idiom as the `?`
            // glyph's `data-mark-for` below — so a test (or anything else)
            // asking "where does the run reach" can find the connector and
            // the cell it continues together, rather than re-deriving the
            // grid's geometry to line them up itself.
            'data-link-for': date,
          }));
        } else if (wk < weeks - 1) {
          // Last row to first: the run wraps to the top of the NEXT column,
          // a jump from bottom-right to top-left that no straight connector
          // can span. Routing an elbow around the grid was tried and looked
          // like a smudge — it crossed unrelated cells and got clipped.
          //
          // Instead, two small tabs: one off the bottom of the week's last
          // row and one off the top of the next week's first. They are the
          // same mark as
          // the within-column connector, so a half-connector reads as
          // "continues" — the way a hyphen at the end of a line does.
          const tab = (cx, cy) => el('rect', {
            x: cx + (CELL - thick) / 2,
            y: cy,
            width: thick,
            height: Math.max(2, GAP * 0.8),
            rx: thick / 2,
            fill: link,
            'fill-opacity': 0.65,
            // Same idiom as the within-column connector above: both tabs are
            // half of the same wrap and both belong to this date.
            'data-link-for': date,
          });

          svg.appendChild(tab(x, y + CELL - 0.5));
          svg.appendChild(tab(x + step, padTop - Math.max(2, GAP * 0.8) + 0.5));
        }
      }
    }
  }

  // The month NAME last captioned, not `getMonth()`. See the caption below.
  let lastMonthText = null;
  const cursor = new Date(start);
  const cells = [];
  // How many cells THIS pass actually gave the continuation stroke — see
  // `data-run-marks` below, set from this count and not from `inStreak.size`.
  let runMarks = 0;

  for (let wk = 0; wk < weeks; wk++) {
    for (let dow = 0; dow < 7; dow++) {
      const date = iso(cursor);
      const x = padLeft + wk * step;
      const y = padTop + dow * step;

      // Future days relative to the real today are not editable and are drawn
      // faintly so the grid keeps its shape.
      const isFuture = date > todayISO;
      // What the cell SAYS, as against the key it is stored under. The popover
      // and the <title> are read by a person and by a screen reader; the range
      // label directly above them is formatted, so these were the last raw ISO
      // left on the card.
      const shown = formatDateShort(fromISOLocal(date));
      const value = entriesByDate[date];
      // `skips` when the caller supplied it — it is the only thing that can be
      // trusted, since 3 is a legitimate amount for a measurable habit. The
      // fallback used to read a bare 3 as a skip for ANY habit, which would
      // paint "3 pages" and "3 cigarettes" as days that never happened while
      // every figure computed from them counted the 3. Narrowed to the one case
      // where the sentinel is unambiguous, matching `normalizeEntry` in
      // shared/src/stats.js. Both live callers pass `skips`; this is what the
      // next one gets if it forgets.
      const isSkip = skips
        ? skips.has(date)
        : habit.type === 'boolean' && value === SKIP;

      let fill = empty;
      let label = `${shown}: no entry`;

      if (isFuture) {
        fill = 'transparent';
        label = `${shown}: in the future`;
      } else if (value == null && habit.unlogged_is_success) {
        // No row at all, on a habit where that already counts as kept —
        // `unlogged_is_success` is server-resolved (`unansweredCounts`), so
        // this never fires for a habit shape the rule does not reach. Faint
        // rather than a new step on the ramp, and well under the 0.15 floor
        // an overage can fall to, so it can never be mistaken for a recorded
        // amount. Both facts stay in the label, because a screen reader gets
        // only the <title> and a faint block and a full one read the same to
        // it.
        fill = shade(color, 0.07);
        label = `${shown}: counted as kept — no entry`;
      } else if (value != null) {
        if (isSkip) {
          fill = themed('--surface-2');
          label = `${shown}: skipped`;
        } else if (habit.type === 'boolean') {
          if (value === YES) { fill = shade(color, 1); label = `${shown}: done`; }
          else label = `${shown}: not done`;
        } else if (isAvoided(habit)) {
          // Shown as something to avoid, so the colours are the other way up —
          // the same inversion `dashboard.js` makes, and for the same reason it
          // gives: filling a slip with a dimmer shade of the habit's own colour
          // is right for a habit read as an AMOUNT, where a bigger number is
          // more done, and reads as having done well on a limit.
          //
          // This branch was missing, so the two grids over one dataset read
          // opposite verdicts: the dashboard painted a cigarette red with an ✗
          // while the calendar three inches away painted it in the habit's own
          // green.
          const target = Number(habit.target_value) || 0;
          const amount = `${value}${habit.unit ? ' ' + habit.unit : ''}`;
          if (value <= target) {
            fill = shade(color, 1);
            label = target > 0 ? `${shown}: clean — ${amount}` : `${shown}: clean`;
          } else {
            fill = themed('--danger');
            label = `${shown}: slipped — ${amount}`;
          }
        } else {
          // For an "at most" habit a low number is the good outcome, so 0 is a
          // full-strength success and must not render as an empty cell.
          if (habit.target_type === 'at_most') {
            const target = habit.target_value;
            // Over target, fade out gradually. The scale is the target itself,
            // or 3 when the target is 0, so 1/2/3 cigarettes stay tellable
            // apart instead of all bottoming out at once.
            const scale = Math.max(target, 3);
            const ratio = value <= target
              ? 1
              : Math.max(0.15, 1 - (value - target) / scale);
            fill = shade(color, ratio);
          } else {
            const target = habit.target_value || 1;
            const ratio = Math.min(1, value / target);
            if (value > 0) fill = shade(color, Math.max(0.2, ratio));
          }
          label = `${shown}: ${value}${habit.unit ? ' ' + habit.unit : ''}`;
        }
      }

      // A day inside a run the connectors above already draw through, but
      // which the branches above left painting nothing at all — `fill ===
      // empty` reads the same binding those branches assign, not a string
      // literal, so a cell that already drew something (a partial fill, an
      // overage, a skip, a slip) is never a candidate. A future day is
      // excluded the same way and needs no separate check: the `isFuture`
      // branch above always assigns `fill = 'transparent'`, so this one
      // predicate already carries that exclusion along with the rest — a
      // stored 0 and a missing row both qualify, since a run is about pace
      // and a stated lapse inside one still is.
      const inRun = inStreak.has(date) && fill === empty;
      if (inRun) label += ' — in a run';

      // `class` via setAttribute, like every other attribute here: the
      // offline render tests drive this module against a minimal fake DOM
      // whose nodes have no classList.
      const rect = el('rect', {
        x, y, width: CELL, height: CELL, rx: 3, fill, class: 'cal-cell',
      });
      if (isFuture) {
        rect.setAttribute('stroke', empty);
        rect.setAttribute('stroke-dasharray', '2 2');
      }
      // Solid, where the future-day stroke above is dashed, so the two read
      // apart. `shade(color, 0.55)` is roughly half the connectors' own
      // `shade(color, 1)` above, so the run's own line stays the dominant
      // mark and this outline reads as its continuation. A stroke sits on no
      // fill ramp, which is the whole reason this is a stroke and not a
      // fill: the cell's fill slot is untouched, so `unknownMark` below still
      // has its `?` to draw.
      if (inRun) {
        rect.setAttribute('stroke', shade(color, 0.55));
        runMarks++;
      }

      if (onPick && !isFuture) {
        rect.setAttribute('cursor', 'pointer');
        rect.setAttribute('role', 'gridcell');
        // Roving tabindex: only one cell is a tab stop, so tabbing past the
        // calendar takes one press rather than ~180. Arrows move within it.
        rect.setAttribute('tabindex', '-1');
        rect.addEventListener('click', () => onPick(date));
        rect.addEventListener('focus', () => setRovingFocus(svg, rect));
        rect.addEventListener('keydown',
          (e) => handleGridKey(e, svg, rect, onPick, weekStart));
        cells.push(rect);
      }

      // The popover shows the bare label; the clickability is obvious from
      // the cursor and does not need repeating in a bubble that follows the
      // pointer. `<title>` keeps the longer form, where a screen-reader user
      // has no cursor to infer it from.
      //
      // setAttribute, not .dataset: the offline render tests use a fake DOM
      // that implements attributes but not the dataset proxy.
      // Which day this cell IS, always — not only when it is clickable.
      //
      // setAttribute, not .dataset: the offline render suites drive this module
      // against a fake DOM that implements attributes only. Unconditional
      // because it is the cell's identity rather than part of its interaction,
      // and because `data-label` beside it is now human copy — "Aug 9, 2026:
      // clean" — so anything that needs the DAY has to have somewhere stable to
      // read it. Two suites were parsing the label's first colon-separated
      // field, which tied them to the wording and to the runner's locale.
      rect.setAttribute('data-date', date);
      rect.setAttribute('data-label', label);
      svg.appendChild(title(rect, onPick && !isFuture ? `${label} — click to edit` : label));

      // A day with no row at all, marked as such when the setting asks for it.
      // Drawn AFTER the cell, since SVG paints in document order — and sized
      // from the cell rather than fixed, because the same glyph has to sit in a
      // 24px square at the closest zoom and an 8px one at the widest. It is
      // deliberately not drawn on a future day: nothing is missing there yet.
      //
      // Nor on a day the cell above already painted as kept: the faint fill
      // is what answers "nobody answered" now, and `?` on top of it would be
      // the same fact drawn twice in one cell where every other habit gets it
      // once.
      //
      // `inRun` deliberately has no place in this gate. It is a stroke, not a
      // fill, so the cell's one fill slot is still `empty` and the glyph slot
      // above it is still free — an in-run unlogged day carries BOTH the
      // stroke and the `?`, unlike the kept-unlogged fill above, which took
      // the glyph's only slot instead of drawing beside it.
      if (unknownMark && !isFuture && value == null && !isSkip && !habit.unlogged_is_success) {
        svg.appendChild(el('text', {
          x: x + CELL / 2,
          y: y + CELL / 2,
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
          'font-size': Math.max(6, Math.round(CELL * 0.72)),
          fill: dim,
          // Or the glyph swallows the click that the cell underneath it wants.
          'pointer-events': 'none',
          // Names the cell it belongs to, so the hover/focus `raise` can carry it
          // along — SVG has no z-index, so a raised cell would otherwise be
          // painted over the top of it.
          'data-mark-for': date,
        }, '?'));
      }

      // month label above the first week containing a new month
      //
      // The change is read from the month NAME, never from `getMonth()`. That
      // is a field of the GREGORIAN calendar, and this caption's text comes
      // from `Intl` — so keying the position on one while taking the words
      // from the other captions a Persian month above the week the Gregorian
      // one happens to start in. Measured over 30 weeks from 2026-01-04 in
      // fa-IR: `بهمن` drawn above week 4 against a real week 2, `اسفند` above
      // week 8 against week 6, `فروردین` above week 13 against week 10 — every
      // caption two to three weeks from the month it names. In English the two
      // agree, which is why this survived the branch that fixed the same shape
      // in `renderGridHeader` and in `weekdayMonthChart`'s year caption.
      const monthText = dow === 0 ? formatMonthShort(cursor) : null;
      if (monthText !== null && monthText !== lastMonthText) {
        lastMonthText = monthText;
        // Nudged left if it would run off the end. The caption is left
        // anchored above a week column, and `Intl`'s short month is `Aug` in
        // English and `أغسطس` in Arabic — measured overflowing the viewBox by
        // 6px on the final column, which an SVG clips rather than wraps.
        //
        // No `WIDTH_SAFETY`, for the reason `weekdayMonthChart` states about
        // its own clamp: in a clamp the margin costs DISPLACEMENT rather than
        // pixels, so it shifts the last caption further left than the overflow
        // it is correcting for — a caption over the wrong column, which is the
        // defect this whole block is about. `estimateTextWidth` is measured
        // never to under-bill, so the raw estimate is already the safe side.
        svg.appendChild(el('text', {
          x: Math.min(x, width - estimateTextWidth(monthText, 9.5)),
          y: 9, 'font-size': 9.5, fill: dim,
        }, monthText));
      }

      cursor.setDate(cursor.getDate() + 1);
    }
  }

  if (onPick && cells.length) {
    svg.setAttribute('role', 'grid');
    // The most recent editable day is the entry point for keyboard users.
    cells[cells.length - 1].setAttribute('tabindex', '0');
  }

  // What the legend under this grid has to describe is THIS window, and the
  // only honest source for that is what this pass actually drew — `inStreak`
  // is the habit's whole history and can hold a run months outside these
  // cells, or hold none at all in a window made entirely of logged days. Set
  // unconditionally, including `"0"`: a caller reading a missing attribute as
  // "no marks" cannot tell that apart from an older `charts.js` that never
  // wrote one at all.
  svg.setAttribute('data-run-marks', String(runMarks));

  attachCellPopover(svg);

  return svg;
}

/**
 * Every date inside a streak of at least `minStreak` days.
 *
 * Built once per render so each cell can ask "am I in a run?" in O(1) — a
 * per-cell scan of the streak list would be ~740 cells times every streak in
 * the habit's history at the widest zoom.
 */
export function streakDates(streaks, minStreak) {
  const dates = new Set();
  if (!streaks) return dates;

  for (const streak of streaks) {
    if (!streak || streak.length < minStreak) continue;
    let cursor = streak.start;
    // Bounded by the streak's own length, so a malformed entry cannot spin.
    for (let i = 0; i < streak.length && cursor <= streak.end; i++) {
      dates.add(cursor);
      cursor = addDaysISO(cursor, 1);
    }
  }
  return dates;
}

/**
 * Shows the day's label in a small popover on hover or focus, and lets the
 * hovered square grow slightly.
 *
 * Delegated from the SVG rather than bound per cell: a year at wide zoom is
 * ~740 squares, and that many listener pairs is a lot of needless work for an
 * effect only one cell shows at a time.
 *
 * The growth itself is a CSS transform (see `.cal-cell` in style.css) so it
 * runs on the compositor. The popover is positioned in JS because an SVG rect
 * has no CSS box for an HTML tooltip to anchor to.
 */
function attachCellPopover(svg) {
  // The offline render tests build charts against a minimal fake DOM with no
  // event or document APIs. The popover is presentation only, so skipping it
  // there costs nothing and keeps the fake from having to grow.
  if (typeof svg.addEventListener !== 'function' ||
      typeof document === 'undefined' ||
      typeof requestAnimationFrame !== 'function') {
    return;
  }

  let pop = null;
  let raf = 0;

  const hide = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    for (const c of svg.querySelectorAll('.cal-cell.is-active')) {
      c.classList.remove('is-active');
    }
    // The node is shared page-wide and stays in the DOM — only its visibility
    // is toggled. Removing it would race every other calendar's reference to
    // it, and an invisible empty div costs nothing.
    const node = pop ?? document.querySelector('.cal-pop');
    pop = null;
    if (node) node.classList.remove('is-open');
  };

  const show = (cell) => {
    const label = cell?.dataset?.label;
    if (!label) return hide();

    for (const c of svg.querySelectorAll('.cal-cell.is-active')) {
      if (c !== cell) c.classList.remove('is-active');
    }
    cell.classList.add('is-active');

    // ONE popover element for the whole page, reused.
    //
    // Each calendar used to create its own. If a re-render happened while the
    // pointer sat still over a cell, the replacement SVG appeared under the
    // motionless pointer, fired `pointerover`, and opened a second popover —
    // which then never closed, because a pointer that does not move generates
    // no further events. It floated over unrelated cards indefinitely.
    // Sharing one node makes that impossible: opening it anywhere moves the
    // same element.
    pop = document.querySelector('.cal-pop');
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'cal-pop';
      // Decorative: the text is already on the cell's <title> for screen
      // readers, and announcing it twice is worse than not at all.
      pop.setAttribute('aria-hidden', 'true');
      document.body.append(pop);
    }
    pop.textContent = label;

    // Measure after the text is set, or the first popover is mispositioned
    // using the previous cell's width.
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!pop) return;
      const box = cell.getBoundingClientRect();
      const own = pop.getBoundingClientRect();
      const gap = 8;

      let left = box.left + box.width / 2 - own.width / 2;
      // Keep it on screen at the edges of the grid.
      left = Math.max(6, Math.min(left, window.innerWidth - own.width - 6));

      // Above the cell, unless that would clip the top of the viewport.
      const above = box.top - own.height - gap;
      const top = above < 6 ? box.bottom + gap : above;

      pop.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      pop.classList.add('is-open');
      pop.classList.toggle('is-below', above < 6);
    });
  };

  const cellFrom = (e) => e.target?.closest?.('.cal-cell') ?? null;

  /*
   * SVG has no z-index: elements paint in document order, so a cell that
   * grows is clipped by every square drawn after it. Moving the hovered cell
   * to the end of its parent is the standard fix. It is one DOM move per
   * hover, and the cell keeps its x/y so nothing visually shifts.
   */
  const raise = (cell) => {
    const parent = cell.parentNode;
    // The `?` on an unanswered day, drawn as its own node just after the cell.
    // Looked up before the early return, because a cell that is already last
    // still has its mark sitting behind it after the first raise.
    const mark = parent?.querySelector?.(
      `[data-mark-for="${cell.getAttribute('data-date')}"]`);
    if (!parent || (parent.lastElementChild === cell && !mark)) return;

    // Re-appending a focused element blurs it, which silently broke arrow-key
    // navigation: the handler reads document.activeElement, and after the
    // move there was nothing focused to read. Restore focus if we took it.
    const refocus = document.activeElement === cell;
    parent.append(cell);
    // The glyph goes with it, or raising the cell buries the very thing the
    // hovered day is being asked about: an opaque square lands on top of the `?`
    // and the 1.45x hover scale covers what is left. Every question mark
    // disappeared exactly under the cursor — which is where it was being read.
    if (mark) parent.append(mark);
    if (refocus) cell.focus({ preventScroll: true });
  };

  svg.addEventListener('pointerover', (e) => {
    const cell = cellFrom(e);
    if (cell) { watchDetach(); raise(cell); show(cell); }
  });
  svg.addEventListener('pointerout', (e) => {
    // Moving between two cells fires out-then-over; only hide when the
    // pointer has actually left the grid, or the popover flickers.
    if (!svg.contains(e.relatedTarget)) hide();
  });
  svg.addEventListener('focusin', (e) => {
    const cell = cellFrom(e);
    watchDetach();
    if (cell) raise(cell);
    show(cell);
  });
  svg.addEventListener('focusout', hide);
  // Scrolling moves the cells out from under a fixed popover.
  svg.closest('.chart-scroll')?.addEventListener('scroll', hide, { passive: true });

  svg.addEventListener('pointerleave', hide);

  // The detail view re-renders on every button press, detaching this SVG. If
  // that happens mid-hover, no pointer event ever fires again and the popover
  // is stranded on the page.
  //
  // Watching the SVG's own parent is not enough: the re-render replaces the
  // children of an ancestor, so the parent is removed *with* the SVG still
  // inside it and never mutates. Polling `isConnected` on each frame while a
  // popover is open is cheap — the loop only runs during a hover, and stops
  // the moment the popover closes.
  let watching = false;
  const watchDetach = () => {
    if (watching) return;
    watching = true;
    const tick = () => {
      if (!pop) { watching = false; return; }   // closed normally
      if (!svg.isConnected) { hide(); watching = false; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
}

/** Make `cell` the single tab stop within this calendar. */
function setRovingFocus(svg, cell) {
  for (const r of svg.querySelectorAll('rect[role="gridcell"]')) {
    r.setAttribute('tabindex', r === cell ? '0' : '-1');
  }
}

/**
 * Arrow keys move by day (left/right) and by week (up/down), matching the
 * visual layout: columns are weeks, rows are weekdays. Home/End jump to the
 * ends of the week, PageUp/PageDown by four weeks.
 */
/** @param {'monday'|'sunday'} [weekStart] */
function handleGridKey(e, svg, cell, onPick, weekStart = 'monday') {
  const date = cell.dataset.date;

  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onPick(date);
    return;
  }

  const steps = {
    ArrowLeft: -7, ArrowRight: 7,   // previous / next week (same weekday)
    ArrowUp: -1, ArrowDown: 1,      // previous / next day
    PageUp: -28, PageDown: 28,
  };
  const delta = steps[e.key];
  if (delta === undefined && e.key !== 'Home' && e.key !== 'End') return;

  e.preventDefault();

  const cells = [...svg.querySelectorAll('rect[role="gridcell"]')];
  const byDate = new Map(cells.map((c) => [c.dataset.date, c]));

  let targetDate;
  if (e.key === 'Home' || e.key === 'End') {
    // Ends of the WEEK as the grid draws it: on a Monday-start calendar Home is
    // Monday, and `getDay()` alone would jump to the Sunday in the column
    // before — off the top of the grid, where `byDate` finds nothing and the
    // key silently does nothing.
    const dow = weekdayIndex(fromISOLocal(date), weekStart);
    targetDate = addDaysISO(date, e.key === 'Home' ? -dow : 6 - dow);
  } else {
    targetDate = addDaysISO(date, delta);
  }

  // Clamp to a real, focusable cell: the edges of the rendered window and
  // future days simply have nothing to land on.
  const next = byDate.get(targetDate);
  if (next) {
    setRovingFocus(svg, next);
    next.focus();
  }
}

/**
 * Weekday consistency month by month: columns are months, rows are weekdays,
 * circle size and opacity are the completion rate.
 *
 * The same idiom as `frequencyChart`, applied to a different question. Where
 * "By day of week" collapses all history into seven bars, this keeps the time
 * axis — so a weekday that used to be reliable and has quietly rotted shows up
 * as a row that fades to the right, which the collapsed view cannot show.
 *
 * Rate, not count: months hold four or five of each weekday, and a raw count
 * would make February look worse than March for no reason.
 */
export function weekdayMonthChart(months, color,
                                  { width = 720, weekStart = 'monday' } = {}) {
  const rowH = 26;
  const ROW_LABEL_SIZE = 10.5;
  const ROW_LABEL_GAP = 8;
  // The row captions are `Intl`'s short weekday names, and those are `Mon` in
  // English, `niedz.` in Polish, `domingo` in pt-PT and `Jumamosi` in sw-KE. A
  // fixed 42px gutter fitted the first two and clipped the others mid-word —
  // measured in Chrome, pt-PT rendered `omingo`, `egunda`, `ábado`.
  //
  // So the gutter is sized from the labels rather than the labels chosen to fit
  // the gutter. `narrow` would fit everywhere and is what this deliberately
  // does NOT use: S/S and T/T are ambiguous and this axis is the whole point of
  // the chart. 42 stays the floor, so nothing narrows in the common case.
  const rowLabels = weekdayNames('short');
  const pad = {
    top: 30, right: 12, bottom: 8,
    left: gutterFor(rowLabels, ROW_LABEL_SIZE, 42, ROW_LABEL_GAP, width * 0.32),
  };
  const height = pad.top + 7 * rowH + pad.bottom;

  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Weekday consistency by month');

  const dim = themed('--text-dim');
  if (!months.length) {
    svg.appendChild(el('text', {
      x: pad.left, y: pad.top + 16, 'font-size': 12, fill: dim,
    }, 'Not enough history yet.'));
    return svg;
  }

  const w = width - pad.left - pad.right;
  const shown = months;
  // Capped: with three months of history, dividing the full card width by
  // three strands the columns in acres of empty space and makes them look
  // unrelated. The grid stays left-aligned at a sensible column width and
  // simply does not fill the card.
  const colW = Math.min(72, w / shown.length);
  const maxR = Math.min(11, colW / 2 - 2, rowH / 2 - 2);

  // Weekday rows in the same order as the calendar heatmap above — which is
  // the account's `weekStart`, not always Sunday. NOT one letter: S/S and T/T
  // are ambiguous and this axis is the whole point of the chart, which is why
  // the hardcoded version wrote `Su`/`Mo`.
  //
  // `Intl` has no two-letter width, so this is `short` — three characters in
  // English, and whatever the locale's own abbreviation is elsewhere. Wider
  // than `Su` by about 6px against a 42px left pad, measured; `narrow` was the
  // other option and would have undone the sentence above.
  const FULL = rotateWeek(weekdayNames('long'), weekStart);
  const SHORT = rotateWeek(rowLabels, weekStart);
  const order = weekOrder(weekStart);
  for (let d = 0; d < 7; d++) {
    svg.appendChild(el('text', {
      x: pad.left - ROW_LABEL_GAP, y: pad.top + d * rowH + rowH / 2 + 4,
      'text-anchor': 'end', 'font-size': ROW_LABEL_SIZE, fill: dim,
      // The unambiguous name, for a reader who cannot tell two abbreviations
      // apart and for a screen reader.
    }, SHORT[d]));
  }

  // A caption is drawn only where thinning leaves room for it. "Every column
  // gets its month" was the rule here and its justification — "the columns are
  // paged rather than squeezed, so there is always room" — is false in any
  // locale whose month names are not three Latin characters: measured at the
  // 12 columns a 328px card allows, vi-VN overlapped on 11 of 12 pairs, by up
  // to 24.9px. Overlapping captions are not a denser axis, they are an
  // unreadable one, and the first and last are the two that orient a reader.
  // No `WIDTH_SAFETY` in either the collision test or the clamp, and both for
  // the reason `streakChart` states: the margin is for RESERVING space, and
  // dropping a caption is a DEGRADATION. Applied here it made the chart
  // pessimistic about its own labels — measured at a 328px card with 8
  // columns, hi-IN kept 4 of 8 when the widest real caption was 21.3px against
  // a 31.2px column, and 11 of 14 non-English locales dropped captions with
  // room to spare. In the clamp the margin costs displacement rather than
  // pixels: it pushed gu-IN's last caption 31.4px left of the column it names,
  // which is a caption over the wrong column. `estimateTextWidth` is measured
  // never to under-bill, so the raw estimate is already the safe side.
  const CAPTION_GAP = 4;
  const captions = shown.map((m, c) => {
    const [yy, mm] = m.month.split('-').map(Number);
    const monthDate = new Date(yy, mm - 1, 15);
    const monthText = formatMonthShort(monthDate);
    const half = estimateTextWidth(monthText, 9.5) / 2;
    const cx = pad.left + (c + 0.5) * colW;
    // Kept inside the viewBox: a centred caption on the first or last column
    // otherwise hangs off the edge once the month name is not three Latin
    // characters.
    return { monthDate, monthText, half, cx,
             x: Math.min(Math.max(cx, half), width - half) };
  });

  // A CONSTANT stride, not a greedy left-to-right walk. The walk this
  // replaces dropped whichever caption collided with the last one DRAWN, so
  // the gap between two shown columns tracked each pair's own widths — which
  // vary within one axis, so the gap does too. Measured at a 328px card with
  // 12 columns: even en-US, three Latin characters wide in every month but
  // one, drew `Jan Mar May Jul Sep Dec` — two months apart four times and
  // then three, from the SAME axis. #131's own argument against a weekday
  // axis with three of seven labelled — "one you have to count along" —
  // applies here exactly the same: a reader scans a constant gap and counts
  // an inconsistent one. So the stride is sized once, from the WIDEST
  // caption on the whole axis, and used for every column alike — no `WIDTH_
  // SAFETY` here either, for the reason already stated above: the raw
  // estimate is already the safe side, and this is a DEGRADATION decision,
  // not a reservation.
  const widestCaption = Math.max(0, ...captions.map((c) => c.half * 2));
  const every = Math.max(1, Math.ceil((widestCaption + CAPTION_GAP) / colW));
  const drawn = new Set();
  for (let c = 0; c < captions.length; c += every) drawn.add(c);

  // The LAST column keeps its caption regardless of where the stride lands —
  // the one a reader is actually looking at, and the one exception to
  // "constant" this makes on purpose. Forcing it in can leave it closer than
  // `every` columns to whichever caption the stride drew last, so that one
  // (and only that one) is dropped in its favour rather than re-walking the
  // whole axis; every OTHER gap stays exactly `every` columns wide.
  const lastIdx = captions.length - 1;
  if (lastIdx >= 0 && !drawn.has(lastIdx)) {
    const prevIdx = every * Math.floor(lastIdx / every);
    if ((lastIdx - prevIdx) * colW < widestCaption + CAPTION_GAP) drawn.delete(prevIdx);
    drawn.add(lastIdx);
  }

  shown.forEach((m, c) => {
    const { monthDate, monthText, half, cx, x } = captions[c];
    if (drawn.has(c)) {
      svg.appendChild(el('text', {
        x, y: 12, 'text-anchor': 'middle', 'font-size': 9.5, fill: dim,
      }, monthText));
    }

    // The year, once, wherever it changes — so a window spanning December
    // into January is not two ambiguous "Jan"s.
    //
    // Both halves read the FORMATTED year and not `yy`. Printing `String(yy)`
    // put a Gregorian number under a localised month name: `مرداد` above
    // `2026`, with this same chart's tooltip 20px away saying `مرداد ۱۴۰۵` —
    // one column, two calendars, 621 years apart. And the change of year is
    // the formatted one too, because a Persian year turns at Farvardin: keyed
    // on `yy` the caption appeared at the January column, which is the middle
    // of a Persian year and not the start of anything.
    const yearText = formatYear(monthDate);
    const prev = shown[c - 1];
    const prevYear = prev
      ? formatYear(new Date(Number(prev.month.slice(0, 4)),
                            Number(prev.month.slice(5, 7)) - 1, 15))
      : null;
    // ...and only under a column that HAS its month caption. The year is here
    // to tell two "Jan"s apart, so with no month name above it there is
    // nothing for it to disambiguate — and a bare year over an unnamed column
    // reads as a label for the column rather than for the run of them. This
    // was visible in about 30 of 48 locales before the last column was
    // reserved above, which is where it usually landed.
    if (yearText !== prevYear && drawn.has(c)) {
      // Placed by the month above it. The month is clamped because a centred
      // caption hangs off the edge once it is not three Latin characters, and
      // the year is localised now too — `พ.ศ. 2569`, `AP ۱۴۰۵`, `2026年`.
      //
      // It takes the MONTH's x rather than clamping itself. Clamped
      // separately it is clamped against its OWN width at its own 8.5px, so
      // wherever either clamp binds the two land on different x and the year
      // stops sitting under the month it qualifies. That is also the one thing
      // the `no year stands over an unnamed column` check compares exactly, so
      // it would have surfaced as a confusing failure of a check about
      // something else. A year here is an annotation on a month caption; it
      // has no position of its own.
      svg.appendChild(el('text', {
        x,
        y: 22, 'text-anchor': 'middle', 'font-size': 8.5,
        fill: dim, 'fill-opacity': 0.75,
      }, yearText));
    }

    // Through the row order, not `forEach`'s index: `computeWeekdayByMonth`
    // returns days indexed by `getDay()`, and the rows are drawn in the
    // account's own week order. Reading them positionally is what would put
    // Sunday's data on Monday's row under a rotated label.
    order.forEach((weekday, r) => {
      const d = m.days[weekday];
      if (!d?.total) return;
      const cy = pad.top + r * rowH + rowH / 2;

      // An empty ring for a weekday that occurred but was never completed:
      // drawing nothing would be indistinguishable from a month where that
      // weekday did not exist in range.
      if (d.rate === 0) {
        svg.appendChild(title(el('circle', {
          cx, cy, r: 3, fill: 'none', stroke: dim, 'stroke-width': 1,
          'stroke-opacity': 0.5,
        }), `${formatStamp(m.month)} ${FULL[r]}: 0 of ${d.total}`));
        return;
      }

      svg.appendChild(title(el('circle', {
        cx, cy, r: 3 + d.rate * (maxR - 3),
        fill: color, 'fill-opacity': 0.3 + 0.7 * d.rate,
      }), `${formatStamp(m.month)} ${FULL[r]}: ${d.completed} of ${d.total} `
        + `(${Math.round(d.rate * 100)}%)`));
    });
  });

  return svg;
}

/* ---------- resilience ---------- */

/**
 * Miss-run distribution: how long your lapses tend to last.
 *
 * Horizontal bars, because the labels ("1–2 weeks") do not fit under vertical
 * ones and the ordering is a scale rather than a set of categories.
 */
export function missDistributionChart(buckets, color, { width = 720 } = {}) {
  const rows = buckets.filter((b) => b.count > 0);
  const rowH = 26;
  const pad = { top: 8, right: 44, bottom: 8, left: 78 };
  const height = pad.top + pad.bottom + Math.max(rows.length, 1) * rowH;

  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'How long lapses last');

  const dim = themed('--text-dim');
  if (!rows.length) {
    svg.appendChild(el('text', {
      x: pad.left, y: pad.top + 16, 'font-size': 12, fill: dim,
    }, 'No lapses yet.'));
    return svg;
  }

  const w = width - pad.left - pad.right;
  const max = Math.max(...rows.map((b) => b.count));

  rows.forEach((b, i) => {
    const y = pad.top + i * rowH;
    const barW = max ? (b.count / max) * w : 0;

    svg.appendChild(el('text', {
      x: pad.left - 8, y: y + 16, 'text-anchor': 'end', 'font-size': 11, fill: dim,
    }, b.label));

    // Shorter lapses are the good outcome, so they get the full colour and
    // longer ones fade — the eye should be drawn to the bottom of the list.
    const strength = Math.max(0.3, 1 - i / rows.length);
    svg.appendChild(title(el('rect', {
      x: pad.left, y: y + 4, width: Math.max(barW, 2), height: rowH - 12,
      rx: 4, fill: shade(color, strength),
    }), `${b.count} lapse${b.count === 1 ? '' : 's'} of ${b.label} (${Math.round(b.share * 100)}%)`));

    svg.appendChild(el('text', {
      x: pad.left + Math.max(barW, 2) + 6, y: y + 16,
      'font-size': 11, fill: themed('--text'),
    }, String(b.count)));
  });

  return svg;
}

/**
 * Survival curve: the share of streaks that reached each length.
 *
 * A descending step curve. The cliff in it is the point worth reading — it
 * locates where this habit reliably breaks, which "best streak: 23" cannot.
 */
export function survivalChart(points, color, { width = 720, height = 190 } = {}) {
  const pad = { top: 14, right: 14, bottom: 30, left: 38 };
  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Share of streaks reaching each length');

  const dim = themed('--text-dim');
  if (points.length < 1) {
    svg.appendChild(el('text', {
      x: pad.left, y: pad.top + 16, 'font-size': 12, fill: dim,
    }, 'Not enough history yet.'));
    return svg;
  }

  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const border = themed('--border');

  for (const frac of [0, 0.5, 1]) {
    const y = pad.top + h - frac * h;
    svg.appendChild(el('line', {
      x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: border, 'stroke-width': 1,
    }));
    svg.appendChild(el('text', {
      x: pad.left - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: dim,
    }, `${Math.round(frac * 100)}%`));
  }

  const slot = points.length > 1 ? w / (points.length - 1) : 0;
  const xAt = (i) => pad.left + (points.length > 1 ? i * slot : w / 2);
  const yAt = (share) => pad.top + h - share * h;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(p.share)}`).join(' ');
  svg.appendChild(el('path', {
    d: line, fill: 'none', stroke: color, 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  points.forEach((p, i) => {
    svg.appendChild(title(el('circle', {
      cx: xAt(i), cy: yAt(p.share), r: 3.5, fill: color,
    }), `${p.reached} of ${p.total} streaks reached ${p.days} days (${Math.round(p.share * 100)}%)`));

    svg.appendChild(el('text', {
      x: xAt(i), y: height - 10, 'text-anchor': 'middle', 'font-size': 11, fill: dim,
    }, `${p.days}d`));
  });

  return svg;
}



/* ---------- history bar chart ---------- */

export function historyChart(buckets, color, { width = 720, height = 190, showPercent = true } = {}) {
  const pad = { top: 12, right: 12, bottom: 34, left: 34 };
  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Completion history');

  if (!buckets.length) return svg;

  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const dim = themed('--text-dim');
  const border = themed('--border');

  const vals = buckets.map((b) =>
    showPercent ? (b.total ? b.completed / b.total : 0) : b.completed
  );
  const max = showPercent ? 1 : Math.max(1, ...vals);

  for (const frac of [0, 0.5, 1]) {
    const y = pad.top + h - frac * h;
    svg.appendChild(el('line', {
      x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: border, 'stroke-width': 1,
    }));
    svg.appendChild(el('text', {
      x: pad.left - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: dim,
    }, showPercent ? `${Math.round(frac * 100)}%` : Math.round(frac * max)));
  }

  const slot = w / buckets.length;
  const barW = Math.max(2, Math.min(28, slot * 0.7));

  buckets.forEach((b, i) => {
    const v = vals[i];
    const barH = max ? (v / max) * h : 0;
    const x = pad.left + i * slot + (slot - barW) / 2;
    const y = pad.top + h - barH;

    const label = showPercent
      ? `${formatStamp(b.bucket)}: ${b.completed}/${b.total} (${Math.round(v * 100)}%)`
      : `${formatStamp(b.bucket)}: ${b.completed}`;

    svg.appendChild(title(el('rect', {
      x, y, width: barW, height: Math.max(barH, v > 0 ? 2 : 0), rx: 3, fill: color,
    }), label));
  });

  // Label a subset of buckets so text never overlaps.
  //
  // The budget is MEASURED from the labels rather than the fixed 62px that
  // stood here. 62 was safe while this drew the raw `2026-08-01` — 49.6px, the
  // same in every locale — and stopped being safe the moment the label became
  // `formatStamp`'s output, which is unbounded: `26 de dez. de 2026` is 78.9px
  // in pt-BR and overlapped its neighbour by 4.5px at a 328px card, which is a
  // card on a phone. Same estimator the row gutters use, for the same reason.
  // No `WIDTH_SAFETY`, and this is the third call site to say so — it decides
  // how many labels to DROP, which is a degradation, not a reservation. The
  // margin makes the chart pessimistic about its own text and thins an axis
  // that had room: at a 328px card with `Jun 2026`-shaped labels it costs
  // about one label slot, so the axis labels one bucket in three where one in
  // two fits. Over-reserving costs pixels; over-degrading costs the label.
  const AXIS_SIZE = 9.5;
  const axisLabels = buckets.map((b) => formatStamp(b.bucket));
  const widestAxis = Math.max(
    1, ...axisLabels.map((t) => estimateTextWidth(t, AXIS_SIZE))
  );
  const every = Math.ceil(
    buckets.length / Math.max(1, Math.floor(w / (widestAxis + 10)))
  );
  buckets.forEach((b, i) => {
    if (i % every !== 0) return;
    svg.appendChild(el('text', {
      x: pad.left + i * slot + slot / 2,
      y: height - 12,
      'text-anchor': 'middle',
      'font-size': AXIS_SIZE,
      fill: dim,
      // The same `formatStamp` the card's own range readout uses. These were
      // the raw bucket key while the header above them was formatted, so one
      // card read `Jul 21, 2026 → Aug 16, 2026` over an axis of `2026-07-21` —
      // which is the "one card, two conventions" this whole change exists to
      // end, reintroduced one card over. On master both halves were raw and
      // at least AGREED.
    }, axisLabels[i]));
  });

  return svg;
}

/* ---------- weekday breakdown ---------- */

export function weekdayChart(days, color,
                             { width = 720, height = 170, weekStart = 'monday' } = {}) {
  const pad = { top: 12, right: 12, bottom: 30, left: 34 };
  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Completions by day of week');

  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const dim = themed('--text-dim');
  const border = themed('--border');

  // Bars in the account's own week order, not `getDay()`'s. `computeWeekdays`
  // indexes by `getDay()`, so this is where the two are reconciled — and both
  // the bar and its caption read through the same array, which is what stops
  // one moving without the other.
  const order = weekOrder(weekStart);
  const rates = days.map((d) => (d.total ? d.completed / d.total : 0));

  for (const frac of [0, 0.5, 1]) {
    const y = pad.top + h - frac * h;
    svg.appendChild(el('line', {
      x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: border, 'stroke-width': 1,
    }));
    svg.appendChild(el('text', {
      x: pad.left - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: dim,
    }, `${Math.round(frac * 100)}%`));
  }

  const slot = w / 7;
  const barW = Math.min(46, slot * 0.6);

  const FULL = weekdayNames('long');
  // Seven captions across one card, so unlike the row gutters this cannot grow
  // to fit — it has to choose a label that does. `Sun Mon Tue` fits anywhere;
  // `domingo segunda terça` and `Jumatatu Jumanne Jumatano` do not, and
  // measured at 360px in pt-PT and sw-KE they overlapped their neighbours.
  //
  // Narrow always fits (one or two characters in every locale checked) and its
  // ambiguity is resolved by the tooltip, which carries the full name — the
  // same trade the calendar heatmap's rows already make. Preferring short
  // where it fits means English and most of Europe are unchanged.
  // The size the labels are DRAWN at, and the size the fit below is decided
  // for. These are one constant because they are one number: measure at 10 and
  // paint at 11 and the chart has chosen a label for a smaller text than the
  // one that appears, which fits in English either way and clips elsewhere.
  const AXIS_SIZE = 11;
  // No `WIDTH_SAFETY`, and that is the same rule `streakChart` states below:
  // RESERVING space uses the margin, because a reservation that is short clips
  // a word; DECIDING TO DEGRADE does not, because there the margin makes the
  // chart pessimistic about itself and throws away a label that would have
  // fitted. This is only ever asked to decide a degradation — short vs narrow,
  // and then whether to shrink — and with the margin applied pt-PT gave up
  // `segunda` for `S T Q Q S S D` at 438px, where the real crossover is about
  // 360. An axis naming three S's and two Q's is not a denser axis; it is one
  // you have to count along, which is the same argument the shrink loop below
  // makes for preferring small type over thinning.
  const fits = (names, size) =>
    names.every((t) => estimateTextWidth(t, size) <= slot);

  const shortNames = weekdayNames('short');
  const SHORT = fits(shortNames, AXIS_SIZE) ? shortNames : weekdayNames('narrow');

  // ...and if even the narrow names do not fit, shrink rather than overlap.
  // Seven captions across one card cannot be thinned the way a time axis can —
  // a weekday axis with three of its seven days labelled is not a denser axis,
  // it is one you have to count along — so the last resort is type size, with
  // a floor below which it would not be readable anyway. Reached only at
  // widths no card uses; without it, ca-ES `dl. dt. dc.` and vi-VN `T2 T3`
  // overlap where English `M T W` has room to spare.
  const LABEL_FLOOR = 8;
  let labelSize = AXIS_SIZE;
  while (labelSize > LABEL_FLOOR && !fits(SHORT, labelSize)) labelSize -= 0.5;

  order.forEach((weekday, i) => {
    const d = days[weekday];
    if (!d) return;
    const rate = rates[weekday];
    const barH = rate * h;
    const x = pad.left + i * slot + (slot - barW) / 2;

    svg.appendChild(title(el('rect', {
      x, y: pad.top + h - barH, width: barW,
      height: Math.max(barH, rate > 0 ? 2 : 0), rx: 4, fill: color,
    }), `${FULL[weekday]}: ${d.completed}/${d.total}`));

    svg.appendChild(el('text', {
      x: pad.left + i * slot + slot / 2, y: height - 10,
      'text-anchor': 'middle', 'font-size': labelSize, fill: dim,
    }, SHORT[weekday]));
  });

  return svg;
}

/* ---------- best streaks ---------- */

/**
 * Loop's "Best streaks" list: the longest runs as horizontal bars scaled to
 * the longest one, each labelled with its date range and length.
 */
export function streakChart(streaks, color, { width = 720, limit = 5 } = {}) {
  const rowH = 30;
  const pad = { top: 6, right: 8, bottom: 6, left: 8 };
  const COUNT_W = 42;
  const LABEL_SIZE = 11.5;

  // Select by length, then present by date, newest first. Two different
  // questions: "which were my best runs" picks the rows, "when were they"
  // orders them — and a list ordered by length reads as a leaderboard, which
  // makes it hard to see whether the good runs were recent or years ago.
  const top = [...streaks]
    .sort((a, b) => b.length - a.length)
    .slice(0, limit)
    .sort((a, b) => b.end.localeCompare(a.end));

  const height = pad.top + Math.max(top.length, 1) * rowH + pad.bottom;

  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Longest streaks');

  const dim = themed('--text-dim');
  const empty = themed('--grid-empty');

  if (!top.length) {
    svg.appendChild(el('text', {
      x: pad.left, y: pad.top + 18, 'font-size': 12, fill: dim,
    }, 'No completed streaks yet.'));
    return svg;
  }

  // The longest of the rows shown, not top[0]: the list is ordered by date
  // now, so the first row is the most recent streak rather than the biggest,
  // and scaling the bars to it would push longer ones off the chart.
  const max = Math.max(...top.map((s) => s.length));

  // Measured, not fixed. This was `168 // room for "12 Mar – 24 Mar"`, written
  // when the label was English and never revisited when it was localised:
  // vi-VN's `28 Tháng 12 2025 – 5 Tháng 1 2026` measures 189.8px on a 328px
  // card and painted 14px INTO the bar it is supposed to sit beside. The same
  // fixed-gutter-against-a-localised-label defect this file fixes in three
  // other charts, left standing in the fourth.
  //
  // `gutterFor` is the wrong tool here and the arithmetic says why: on a 328px
  // card its ceiling — 60% of the plot — is 166.8, BELOW this 168 floor. A
  // ceiling under a floor is not a bound; the floor simply wins, the
  // measurement is discarded, and the gap comes off the top, leaving a label
  // narrower than a fixed number would have given it at the one width this
  // matters most. Reach for it here again and check that pair first.
  //
  // So the label gets what the card can spare and never less than it had, and
  // where that is still not enough the TYPE shrinks — the same last resort
  // `weekdayChart` uses, for the same reason: a label painted over its own bar
  // is worse than a small one. lv-LV's
  // `2025. gada 28. dec. – 2026. gada 4. janv.` needs about 8px of type on a
  // phone; master painted 47.6px of it across the bar.
  const LABEL_GAP = 8;
  // 8, as `weekdayChart`'s is — a size chosen for legibility, and it must not
  // be lowered to accommodate an overflow. The Devanagari and Bengali numeric
  // forms appear to miss by two pixels here, and that is `estimateTextWidth`
  // billing their DIGITS at the Indic letter rate, 1.77x the same string in
  // ASCII; the answer is to classify a numeral as a numeral, which `dates.js`
  // now does. Measured across 18 locales at five widths from 200px up, no
  // label overflows its reservation — the loop below is not reached at all,
  // because the ISO fallback above has already made the label fit.
  const LABEL_FLOOR = 8;
  const widestOf = (set, size) =>
    Math.max(0, ...set.map((t) => estimateTextWidth(t, size)));

  // RESERVING uses the safety margin, because a reservation that is short
  // clips a word.
  const wordy = top.map((s) => rangeLabel(s.start, s.end));
  const LABEL_W = Math.max(168,
    Math.min(Math.ceil(widestOf(wordy, LABEL_SIZE) * WIDTH_SAFETY) + LABEL_GAP,
             (width - pad.left - pad.right - COUNT_W) * 0.55));

  // The FORMAT is chosen before the type size, because writing the same dates
  // in digits is a smaller loss than making them unreadable. lv-LV's
  // `2025. gada 28. dec. – 2026. gada 4. janv.` fits no card at any legible
  // size; `2025-12-28 – 2026-01-04` says the same thing and fits.
  const labels = widestOf(wordy, LABEL_SIZE) <= LABEL_W - LABEL_GAP
    ? wordy
    : top.map((s) => rangeLabel(s.start, s.end, 'short'));

  // DEGRADING does not. The margin is there so a reservation is never short;
  // applied to a decision about whether to shrink the type it makes the chart
  // pessimistic about itself and shrinks labels that would have fitted — en-US
  // went to the 8px floor over about two pixels of real overflow. Over-
  // reserving a gutter costs pixels; over-reserving here costs legibility.
  let labelSize = LABEL_SIZE;
  while (labelSize > LABEL_FLOOR && widestOf(labels, labelSize) > LABEL_W - LABEL_GAP) {
    labelSize -= 0.5;
  }

  const barX = pad.left + LABEL_W;
  const barMax = width - pad.right - COUNT_W - barX;

  top.forEach((s, i) => {
    const y = pad.top + i * rowH;
    const cy = y + rowH / 2;
    const w = Math.max(3, (s.length / max) * barMax);

    // date range, e.g. "21 Apr – 18 May 2026"
    svg.appendChild(el('text', {
      x: pad.left, y: cy + 4, 'font-size': labelSize, fill: dim,
    }, labels[i]));

    // track + bar
    svg.appendChild(el('rect', {
      x: barX, y: cy - 7, width: barMax, height: 14, rx: 4, fill: empty,
    }));
    svg.appendChild(title(el('rect', {
      x: barX, y: cy - 7, width: w, height: 14, rx: 4, fill: color,
      'fill-opacity': 0.45 + 0.55 * (s.length / max),
    }), `${s.length} days: ${formatStamp(s.start)} to ${formatStamp(s.end)}`));

    // length
    svg.appendChild(el('text', {
      x: width - pad.right, y: cy + 4, 'text-anchor': 'end',
      'font-size': 12, fill: themed('--text'), 'font-weight': 600,
    }, String(s.length)));
  });

  return svg;
}

/**
 * "21 Apr – 18 May 2026" — what the two ends share is `Intl`'s decision, not
 * ours, and so is the field order and the calendar.
 */
function rangeLabel(startISO, endISO, style) {
  return formatDayRange(fromISOLocal(startISO), fromISOLocal(endISO), style);
}

/* ---------- frequency bubble chart ---------- */

export function frequencyChart(months, color, { width = 720 } = {}) {
  const rowH = 26;
  const ROW_LABEL_SIZE = 10.5;
  const ROW_LABEL_GAP = 8;
  // Sized from the labels, like `weekdayMonthChart`'s. These rows used to read
  // the raw `2026-06`, which is seven characters in every language; they read
  // `formatStamp` now, and that is `Jun 2026` in English, `2026年6月` in
  // Japanese, `2026. g. jūn.` in Latvian and `أغسطس ٢٠٢٦` in Arabic. Measured
  // in Chrome at 360px: the last three overflowed a fixed 58px gutter by up to
  // 13px, which is a label running off the left of the card.
  const rowLabels = months.map((m) => formatStamp(m.month));
  const pad = {
    top: 18, right: 12, bottom: 8,
    left: gutterFor(rowLabels, ROW_LABEL_SIZE, 58, ROW_LABEL_GAP, width * 0.32),
  };

  const maxPerWeek = Math.max(
    1,
    ...months.flatMap((m) => Object.keys(m.counts).map(Number))
  );
  // Draw everything handed over. This used to re-clamp to 12 rows and slice
  // the oldest away — but the caller (windowedChart) has already decided how
  // many months fit and labels the range accordingly, so the two clamps
  // fought: the header claimed "2025-05 → 2026-08" while four of those months
  // were drawn on no page at all, reachable by no amount of paging.
  const shown = months;
  const rows = Math.max(shown.length, 1);
  const height = pad.top + rows * rowH + pad.bottom;

  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Times per week by month');

  const dim = themed('--text-dim');
  const w = width - pad.left - pad.right;
  const colW = w / maxPerWeek;

  for (let n = 1; n <= maxPerWeek; n++) {
    svg.appendChild(el('text', {
      x: pad.left + (n - 0.5) * colW, y: 11,
      'text-anchor': 'middle', 'font-size': 10, fill: dim,
    }, `${n}×`));
  }

  const maxCount = Math.max(
    1,
    ...shown.flatMap((m) => Object.values(m.counts))
  );

  shown.forEach((m, r) => {
    const cy = pad.top + r * rowH + rowH / 2;
    svg.appendChild(el('text', {
      x: pad.left - ROW_LABEL_GAP, y: cy + 4, 'text-anchor': 'end',
      'font-size': ROW_LABEL_SIZE, fill: dim,
    }, rowLabels[r]));

    for (let n = 1; n <= maxPerWeek; n++) {
      const count = m.counts[n] ?? 0;
      if (!count) continue;
      const radius = 4 + (count / maxCount) * 7;
      svg.appendChild(title(el('circle', {
        cx: pad.left + (n - 0.5) * colW, cy, r: radius,
        fill: color, 'fill-opacity': 0.35 + 0.65 * (count / maxCount),
      }), `${rowLabels[r]}: ${count} week(s) with ${n} completion(s)`));
    }
  });

  return svg;
}
