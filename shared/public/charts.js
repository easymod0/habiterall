/**
 * Minimal SVG chart helpers. Hand-rolled rather than pulled from a library so
 * the app ships with no frontend build step and no CDN dependency.
 */

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
    weeks = 53,
    endDate = null,     // last date shown; defaults to today
    skips = null,       // Set of skipped dates, kept out of the value space
    onPick = null,      // callback(date) -> makes cells clickable
  } = opts;

  const CELL = 13;
  const GAP = 3;
  const step = CELL + GAP;
  const padLeft = 22;
  const padTop = 16;

  const width = padLeft + weeks * step;
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

  const start = new Date(last);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay());

  for (let i = 0; i < 3; i += 2) {
    svg.appendChild(el('text', {
      x: 0, y: padTop + (i * step) + CELL - 2, 'font-size': 9, fill: dim,
    }, WEEKDAY_LABELS[i]));
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

      const rect = el('rect', {
        x, y, width: CELL, height: CELL, rx: 3, fill,
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

  return svg;
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

  const top = [...streaks].sort((a, b) => b.length - a.length).slice(0, limit);
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

  const max = top[0].length;
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
