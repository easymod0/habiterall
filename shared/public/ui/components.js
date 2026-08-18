/**
 * The generic pieces the views are built from: a card, a subheading, a
 * segmented control, and the paging wrapper every time-axis chart needs.
 *
 * These were buried 1,500 lines into the detail view, which is why nothing
 * else used them. Mostly they know nothing about habits; `habitIcon` is the
 * one exception, placed here rather than in a new file because a one-off
 * helper does not earn its own `SHELL` entry and `CACHE_VERSION` bump.
 */

import { columnsForWidth, windowSlice } from '/shared/ui/window.js';
import { state } from '/shared/ui/store.js';

export function card(titleText, content) {
  const c = document.createElement('div');
  c.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = titleText;
  head.append(t);
  c.append(head);
  if (content) c.append(content);
  return c;
}

/**
 * The habit's icon as a span, or null when it has none. `aria-hidden` always:
 * an emoji announces as its Unicode name ("person running facing right"),
 * which is noise on every row, and the icon must never replace the name a
 * screen reader gets — the name element beside it stays the accessible one.
 */
export function habitIcon(habit) {
  if (!habit?.icon) return null;
  const span = document.createElement('span');
  span.className = 'habit-icon';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = habit.icon;
  return span;
}

export function subheading(text) {
  const h = document.createElement('div');
  h.className = 'card-subhead';
  h.textContent = text;
  return h;
}

export function segmented(options, active, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'seg';
  for (const opt of options) {
    const b = document.createElement('button');
    b.textContent = opt;
    b.setAttribute('aria-pressed', String(opt === active));
    b.addEventListener('click', () => onChange(opt));
    wrap.append(b);
  }
  return wrap;
}

/**
 * Usable width inside a `.card` placed in `container`, in CSS pixels.
 *
 * Measured from a real card rather than subtracting a hardcoded number:
 * `.card` carries 16px of padding *and* a 1px border on each side, and an
 * assumed 32 left the SVG 33px wider than its box — enough for
 * `max-width: 100%` to scale the whole chart down, so 13px cells rendered at
 * 12.6px. Measuring cannot drift from the stylesheet.
 */
export function cardInnerWidth(container) {
  const outer = container?.clientWidth ?? 0;
  if (!outer) return 720; // detached or hidden; the old fixed width is a safe floor

  const probe = document.createElement('div');
  probe.className = 'card';
  // `visibility`, not `position: absolute` — taking the probe out of flow
  // collapses it to its (empty) content instead of stretching to the
  // container, which is how this first returned 720 on a 1026px card. It
  // still occupies a row for one frame, but nothing is painted and it is
  // removed before the browser can render.
  probe.style.visibility = 'hidden';
  probe.style.margin = '0';
  container.append(probe);

  const cs = getComputedStyle(probe);
  const inner = probe.clientWidth
    - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  probe.remove();

  return inner > 0 ? Math.floor(inner) : 720;
}

/**
 * Render a chart over a scrollable window of its data, with ‹ Earlier /
 * Later › controls when the data does not fit.
 *
 * Every chart with an unbounded time axis needs this: `slot = width / count`
 * shrinks bars to hairlines once there is a year of daily data. Capacity comes
 * from a minimum per-column width rather than a fixed number, so a wide
 * monitor shows more and a phone shows fewer.
 *
 * The paging offset lives in `state.chartOffsets`, keyed per chart, so the
 * position survives the re-render each button press causes.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.card    the card to add controls and chart to
 * @param {string} opts.key          identity for the stored offset
 * @param {Array} opts.items         full series, oldest first
 * @param {'bar'|'circle'|'point'|number} opts.density  a MIN_SLOT key, or pixels
 * @param {number} opts.width
 * @param {(slice: Array) => Node} opts.render
 * @param {(item: any) => string} [opts.labelOf]  for the range readout
 * @param {() => void} opts.redraw
 */
export function windowedChart(opts) {
  const { card: host, key, items, density, width, render, labelOf, redraw } = opts;

  const capacity = columnsForWidth(width, density);
  const win = windowSlice(items, capacity, state.chartOffsets[key] ?? 0);
  // Write the clamped value back, so paging past an end does not leave a
  // stale offset that shifts the window on the next render.
  state.chartOffsets[key] = win.offset;

  if (win.canGoEarlier || win.canGoLater) {
    const head = host.querySelector('.card-head');
    const nav = document.createElement('div');
    nav.className = 'cal-nav';

    const mkNav = (text, label, disabled, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm';
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.disabled = disabled;
      b.addEventListener('click', fn);
      return b;
    };

    const page = (by) => {
      // Page by most of a screen, keeping a column of overlap for context.
      const stride = Math.max(1, win.slice.length - 1);
      state.chartOffsets[key] = win.offset + by * stride;
      redraw();
    };

    const range = document.createElement('span');
    range.className = 'cal-range';
    if (labelOf && win.slice.length) {
      range.textContent = win.slice.length === 1
        ? labelOf(win.slice[0])
        : `${labelOf(win.slice[0])} → ${labelOf(win.slice[win.slice.length - 1])}`;
    }

    nav.append(
      mkNav('‹ Earlier', 'Show earlier', !win.canGoEarlier, () => page(1)),
      range,
      mkNav('Later ›', 'Show later', !win.canGoLater, () => page(-1)),
      mkNav('Now', 'Jump to the most recent', !win.canGoLater, () => {
        state.chartOffsets[key] = 0;
        redraw();
      }),
    );
    head.append(nav);
  }

  const scroll = document.createElement('div');
  scroll.className = 'chart-scroll';
  scroll.append(render(win.slice));
  host.append(scroll);
  return host;
}
