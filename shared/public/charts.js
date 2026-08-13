/**
 * Minimal SVG chart helpers. Hand-rolled rather than pulled from a library so
 * the app ships with no frontend build step and no CDN dependency.
 */

// Relative, not '/shared/...': two test suites import this module directly in
// Node, where a root-absolute specifier resolves against the filesystem root.
// A relative path works in both the browser and Node.
import {
  calendarWindow, zoomLevel, calendarWidth, CALENDAR_PAD_LEFT, DEFAULT_ZOOM,
} from './ui/calendar.js';

const NS = 'http://www.w3.org/2000/svg';
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

/** Reads a CSS custom property so charts follow the active theme. */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Blend a hex color toward the surface color by `t` (0 = surface, 1 = full). */
function shade(hex, t) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const base = dark ? [35, 40, 48] : [230, 233, 239];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c, i) => Math.round(base[i] + (c - base[i]) * t);
  return `rgb(${mix(r, 0)}, ${mix(g, 1)}, ${mix(b, 2)})`;
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
  const dim = cssVar('--text-dim');
  const border = cssVar('--border');

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

  // date labels at both ends
  svg.appendChild(el('text', {
    x: pad.left, y: height - 6, 'font-size': 10, fill: dim,
  }, scores[0].date));
  svg.appendChild(el('text', {
    x: width - pad.right, y: height - 6, 'text-anchor': 'end',
    'font-size': 10, fill: dim,
  }, scores[scores.length - 1].date));

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
    minStreak = 3,      // shorter runs are noise, not an achievement
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
  // The extra 4px at the foot leaves room for the wrap tab hanging below
  // Saturday; the one above Sunday sits inside padTop's existing space.
  const height = padTop + 7 * step + 4;
  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Completion calendar');

  const dim = cssVar('--text-dim');
  const empty = cssVar('--grid-empty');

  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const realToday = new Date();
  realToday.setHours(0, 0, 0, 0);
  const todayISO = iso(realToday);

  // The grid ends on `endDate` (or today) and runs `weeks` back from there.
  const last = endDate ? fromISOLocal(endDate) : new Date(realToday);
  last.setHours(0, 0, 0, 0);

  // The window is anchored on its end so `last` is always drawn — see
  // calendarWindow, where the reasoning and the regression test live.
  const start = fromISOLocal(calendarWindow(iso(last), weeks).start);

  for (let i = 0; i < 3; i += 2) {
    svg.appendChild(el('text', {
      x: 0, y: padTop + (i * step) + CELL - 2, 'font-size': 9, fill: dim,
    }, WEEKDAY_LABELS[i]));
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
        if (!inStreak.has(date) || !inStreak.has(shiftISO(date, 1))) continue;

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
          }));
        } else if (wk < weeks - 1) {
          // Saturday to Sunday: the run wraps to the top of the NEXT column,
          // a jump from bottom-right to top-left that no straight connector
          // can span. Routing an elbow around the grid was tried and looked
          // like a smudge — it crossed unrelated cells and got clipped.
          //
          // Instead, two small tabs: one off the bottom of Saturday and one
          // off the top of the following Sunday. They are the same mark as
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
          });

          svg.appendChild(tab(x, y + CELL - 0.5));
          svg.appendChild(tab(x + step, padTop - Math.max(2, GAP * 0.8) + 0.5));
        }
      }
    }
  }

  let lastMonth = -1;
  const cursor = new Date(start);
  const cells = [];

  for (let wk = 0; wk < weeks; wk++) {
    for (let dow = 0; dow < 7; dow++) {
      const date = iso(cursor);
      const x = padLeft + wk * step;
      const y = padTop + dow * step;

      // Future days relative to the real today are not editable and are drawn
      // faintly so the grid keeps its shape.
      const isFuture = date > todayISO;
      const value = entriesByDate[date];
      const isSkip = skips ? skips.has(date) : value === 3;

      let fill = empty;
      let label = `${date}: no entry`;

      if (isFuture) {
        fill = 'transparent';
        label = `${date}: in the future`;
      } else if (value != null) {
        if (isSkip) {
          fill = cssVar('--surface-2');
          label = `${date}: skipped`;
        } else if (habit.type === 'boolean') {
          if (value === 2) { fill = shade(color, 1); label = `${date}: done`; }
          else label = `${date}: not done`;
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
          label = `${date}: ${value}${habit.unit ? ' ' + habit.unit : ''}`;
        }
      }

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

      if (onPick && !isFuture) {
        rect.setAttribute('cursor', 'pointer');
        rect.setAttribute('role', 'gridcell');
        rect.dataset.date = date;
        // Roving tabindex: only one cell is a tab stop, so tabbing past the
        // calendar takes one press rather than ~180. Arrows move within it.
        rect.setAttribute('tabindex', '-1');
        rect.addEventListener('click', () => onPick(date));
        rect.addEventListener('focus', () => setRovingFocus(svg, rect));
        rect.addEventListener('keydown', (e) => handleGridKey(e, svg, rect, onPick));
        cells.push(rect);
      }

      // The popover shows the bare label; the clickability is obvious from
      // the cursor and does not need repeating in a bubble that follows the
      // pointer. `<title>` keeps the longer form, where a screen-reader user
      // has no cursor to infer it from.
      //
      // setAttribute, not .dataset: the offline render tests use a fake DOM
      // that implements attributes but not the dataset proxy.
      rect.setAttribute('data-label', label);
      svg.appendChild(title(rect, onPick && !isFuture ? `${label} — click to edit` : label));

      // month label above the first week containing a new month
      if (dow === 0 && cursor.getMonth() !== lastMonth) {
        lastMonth = cursor.getMonth();
        svg.appendChild(el('text', {
          x, y: 9, 'font-size': 9.5, fill: dim,
        }, MONTH_LABELS[lastMonth]));
      }

      cursor.setDate(cursor.getDate() + 1);
    }
  }

  if (onPick && cells.length) {
    svg.setAttribute('role', 'grid');
    // The most recent editable day is the entry point for keyboard users.
    cells[cells.length - 1].setAttribute('tabindex', '0');
  }

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
function streakDates(streaks, minStreak) {
  const dates = new Set();
  if (!streaks) return dates;

  for (const streak of streaks) {
    if (!streak || streak.length < minStreak) continue;
    let cursor = streak.start;
    // Bounded by the streak's own length, so a malformed entry cannot spin.
    for (let i = 0; i < streak.length && cursor <= streak.end; i++) {
      dates.add(cursor);
      cursor = shiftISO(cursor, 1);
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
    if (!pop) return;
    pop.classList.remove('is-open');
    const node = pop;
    pop = null;
    // Let the fade finish before removing, or it vanishes abruptly.
    setTimeout(() => node.remove(), 160);
  };

  const show = (cell) => {
    const label = cell?.dataset?.label;
    if (!label) return hide();

    for (const c of svg.querySelectorAll('.cal-cell.is-active')) {
      if (c !== cell) c.classList.remove('is-active');
    }
    cell.classList.add('is-active');

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
    if (!parent || parent.lastElementChild === cell) return;

    // Re-appending a focused element blurs it, which silently broke arrow-key
    // navigation: the handler reads document.activeElement, and after the
    // move there was nothing focused to read. Restore focus if we took it.
    const refocus = document.activeElement === cell;
    parent.append(cell);
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
function handleGridKey(e, svg, cell, onPick) {
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
    const dow = fromISOLocal(date).getDay();
    targetDate = shiftISO(date, e.key === 'Home' ? -dow : 6 - dow);
  } else {
    targetDate = shiftISO(date, delta);
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
export function weekdayMonthChart(months, color, { width = 720 } = {}) {
  const rowH = 26;
  // Two lines of header: the month on every column, the year where it changes.
  const pad = { top: 30, right: 12, bottom: 8, left: 42 };
  const height = pad.top + 7 * rowH + pad.bottom;

  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Weekday consistency by month');

  const dim = cssVar('--text-dim');
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

  // Weekday rows, Sunday first to match the calendar heatmap above it.
  // Two letters, not one: S/S and T/T are ambiguous, and this axis is the
  // whole point of the chart.
  const FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  for (let d = 0; d < 7; d++) {
    svg.appendChild(el('text', {
      x: pad.left - 8, y: pad.top + d * rowH + rowH / 2 + 4,
      'text-anchor': 'end', 'font-size': 10.5, fill: dim,
    }, SHORT[d]));
  }

  shown.forEach((m, c) => {
    const cx = pad.left + (c + 0.5) * colW;

    // Every column gets its month. The columns are now paged rather than
    // squeezed, so there is always room — and a chart whose axis labels only
    // some columns makes you count to work out which one you are looking at.
    const [yy, mm] = m.month.split('-').map(Number);
    svg.appendChild(el('text', {
      x: cx, y: 12, 'text-anchor': 'middle', 'font-size': 9.5, fill: dim,
    }, MONTH_LABELS[mm - 1]));

    // The year, once, wherever it changes — so a window spanning December
    // into January is not two ambiguous "Jan"s.
    if (c === 0 || yy !== Number(shown[c - 1].month.split('-')[0])) {
      svg.appendChild(el('text', {
        x: cx, y: 22, 'text-anchor': 'middle', 'font-size': 8.5,
        fill: dim, 'fill-opacity': 0.75,
      }, String(yy)));
    }

    m.days.forEach((d, r) => {
      if (!d.total) return;
      const cy = pad.top + r * rowH + rowH / 2;

      // An empty ring for a weekday that occurred but was never completed:
      // drawing nothing would be indistinguishable from a month where that
      // weekday did not exist in range.
      if (d.rate === 0) {
        svg.appendChild(title(el('circle', {
          cx, cy, r: 3, fill: 'none', stroke: dim, 'stroke-width': 1,
          'stroke-opacity': 0.5,
        }), `${m.month} ${FULL[r]}: 0 of ${d.total}`));
        return;
      }

      svg.appendChild(title(el('circle', {
        cx, cy, r: 3 + d.rate * (maxR - 3),
        fill: color, 'fill-opacity': 0.3 + 0.7 * d.rate,
      }), `${m.month} ${FULL[r]}: ${d.completed} of ${d.total} (${Math.round(d.rate * 100)}%)`));
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

  const dim = cssVar('--text-dim');
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
      'font-size': 11, fill: cssVar('--text'),
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

  const dim = cssVar('--text-dim');
  if (points.length < 1) {
    svg.appendChild(el('text', {
      x: pad.left, y: pad.top + 16, 'font-size': 12, fill: dim,
    }, 'Not enough history yet.'));
    return svg;
  }

  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const border = cssVar('--border');

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

function shiftISO(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Parse 'YYYY-MM-DD' as a local date (not UTC, which would shift westward). */
function fromISOLocal(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/* ---------- history bar chart ---------- */

export function historyChart(buckets, color, { width = 720, height = 190, showPercent = true } = {}) {
  const pad = { top: 12, right: 12, bottom: 34, left: 34 };
  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Completion history');

  if (!buckets.length) return svg;

  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const dim = cssVar('--text-dim');
  const border = cssVar('--border');

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
      ? `${b.bucket}: ${b.completed}/${b.total} (${Math.round(v * 100)}%)`
      : `${b.bucket}: ${b.completed}`;

    svg.appendChild(title(el('rect', {
      x, y, width: barW, height: Math.max(barH, v > 0 ? 2 : 0), rx: 3, fill: color,
    }), label));
  });

  // Label a subset of buckets so text never overlaps.
  const every = Math.ceil(buckets.length / Math.max(1, Math.floor(w / 62)));
  buckets.forEach((b, i) => {
    if (i % every !== 0) return;
    svg.appendChild(el('text', {
      x: pad.left + i * slot + slot / 2,
      y: height - 12,
      'text-anchor': 'middle',
      'font-size': 9.5,
      fill: dim,
    }, b.bucket));
  });

  return svg;
}

/* ---------- weekday breakdown ---------- */

export function weekdayChart(days, color, { width = 720, height = 170 } = {}) {
  const pad = { top: 12, right: 12, bottom: 30, left: 34 };
  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Completions by day of week');

  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const dim = cssVar('--text-dim');
  const border = cssVar('--border');

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

  days.forEach((d, i) => {
    const rate = rates[i];
    const barH = rate * h;
    const x = pad.left + i * slot + (slot - barW) / 2;

    svg.appendChild(title(el('rect', {
      x, y: pad.top + h - barH, width: barW,
      height: Math.max(barH, rate > 0 ? 2 : 0), rx: 4, fill: color,
    }), `${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][i]}: ${d.completed}/${d.total}`));

    svg.appendChild(el('text', {
      x: pad.left + i * slot + slot / 2, y: height - 10,
      'text-anchor': 'middle', 'font-size': 11, fill: dim,
    }, ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][i]));
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
  const LABEL_W = 168;   // room for "12 Mar – 24 Mar"
  const COUNT_W = 42;

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

  const dim = cssVar('--text-dim');
  const empty = cssVar('--grid-empty');

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
  const barX = pad.left + LABEL_W;
  const barMax = width - pad.right - COUNT_W - barX;

  top.forEach((s, i) => {
    const y = pad.top + i * rowH;
    const cy = y + rowH / 2;
    const w = Math.max(3, (s.length / max) * barMax);

    // date range, e.g. "21 Apr – 18 May 2026"
    svg.appendChild(el('text', {
      x: pad.left, y: cy + 4, 'font-size': 11.5, fill: dim,
    }, formatRange(s.start, s.end)));

    // track + bar
    svg.appendChild(el('rect', {
      x: barX, y: cy - 7, width: barMax, height: 14, rx: 4, fill: empty,
    }));
    svg.appendChild(title(el('rect', {
      x: barX, y: cy - 7, width: w, height: 14, rx: 4, fill: color,
      'fill-opacity': 0.45 + 0.55 * (s.length / max),
    }), `${s.length} days: ${s.start} to ${s.end}`));

    // length
    svg.appendChild(el('text', {
      x: width - pad.right, y: cy + 4, 'text-anchor': 'end',
      'font-size': 12, fill: cssVar('--text'), 'font-weight': 600,
    }, String(s.length)));
  });

  return svg;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "21 Apr – 18 May 2026", collapsing to a single date for one-day streaks and
 * dropping the repeated year.
 */
function formatRange(startISO, endISO) {
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const [ey, em, ed] = endISO.split('-').map(Number);

  const s = `${sd} ${MONTH_SHORT[sm - 1]}`;
  const e = `${ed} ${MONTH_SHORT[em - 1]}`;

  if (startISO === endISO) return `${s} ${sy}`;
  if (sy !== ey) return `${s} ${sy} – ${e} ${ey}`;
  return `${s} – ${e} ${ey}`;
}

/* ---------- frequency bubble chart ---------- */

export function frequencyChart(months, color, { width = 720 } = {}) {
  const rowH = 26;
  const pad = { top: 18, right: 12, bottom: 8, left: 58 };

  const maxPerWeek = Math.max(
    1,
    ...months.flatMap((m) => Object.keys(m.counts).map(Number))
  );
  const rows = Math.min(months.length, 12);
  const shown = months.slice(-rows);
  const height = pad.top + rows * rowH + pad.bottom;

  const svg = svgRoot(width, height);
  svg.setAttribute('aria-label', 'Times per week by month');

  const dim = cssVar('--text-dim');
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
      x: pad.left - 8, y: cy + 4, 'text-anchor': 'end', 'font-size': 10.5, fill: dim,
    }, m.month));

    for (let n = 1; n <= maxPerWeek; n++) {
      const count = m.counts[n] ?? 0;
      if (!count) continue;
      const radius = 4 + (count / maxCount) * 7;
      svg.appendChild(title(el('circle', {
        cx: pad.left + (n - 0.5) * colW, cy, r: radius,
        fill: color, 'fill-opacity': 0.35 + 0.65 * (count / maxCount),
      }), `${m.month}: ${count} week(s) with ${n} completion(s)`));
    }
  });

  return svg;
}
