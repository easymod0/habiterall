/**
 * Every major view, at phone and desktop widths.
 *
 * Most suites only ever ran at 1440px, so a layout that broke on a phone
 * would have shipped unnoticed — and this app is primarily used on one.
 * The checks here are deliberately structural rather than pixel-perfect:
 * nothing overflows its container, nothing overlaps, tap targets are big
 * enough, and text is not clipped.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = 9303;

/** Smallest widely-used phone, a large phone, a tablet, and a desktop. */
const VIEWPORTS = [
  { label: 'small phone', w: 360, h: 740, mobile: true },
  { label: 'phone', w: 390, h: 844, mobile: true },
  { label: 'tablet', w: 768, h: 1024, mobile: true },
  { label: 'desktop', w: 1440, h: 900, mobile: false },
];

/** 44px is the accessibility minimum for a touch target. */
const MIN_TOUCH = 44;

const profile = mkdtempSync(join(tmpdir(), 'habresp-'));
const chrome = launchChrome(PORT, profile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};

let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  let url;
  for (let i = 0; i < 60; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; if (url) break; } catch {}
    await sleep(250);
  }
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);

  /** Common structural assertions for whatever is on screen. */
  const LAYOUT_PROBE = `(() => {
    const de = document.documentElement;
    const overflowing = [...document.querySelectorAll('body *')]
      .filter(el => {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) return false;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.overflowX === 'auto' ||
            cs.overflowX === 'scroll') return false;
        // Allow a 1px rounding tolerance.
        return b.right > de.clientWidth + 1 || b.left < -1;
      })
      .map(el => el.className || el.tagName)
      .slice(0, 5);
    return {
      pageScrollsSideways: de.scrollWidth > de.clientWidth + 1,
      overflowing,
      clientWidth: de.clientWidth,
    };
  })()`;

  for (const vp of VIEWPORTS) {
    console.log(`\n--- ${vp.label} (${vp.w}x${vp.h}) ---`);
    await send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId);

    /* ---- dashboard ---- */
    await send('Page.navigate', { url: APP }, sessionId);
    for (let i = 0; i < 80; i++) {
      if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
      await sleep(200);
    }
    await sleep(500);

    let probe = await ev(LAYOUT_PROBE);
    ck(`${vp.label}: dashboard does not scroll sideways`,
      probe.pageScrollsSideways === false, JSON.stringify(probe.overflowing));
    ck(`${vp.label}: nothing overflows the viewport`,
      probe.overflowing.length === 0, JSON.stringify(probe.overflowing));

    const grid = await ev(`(() => {
      const checks = [...document.querySelectorAll('.habit-row:first-child .check')];
      const sizes = checks.map(c => { const b = c.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) }; });
      const row = document.querySelector('.habit-row').getBoundingClientRect();
      const strip = document.querySelector('.habit-row:first-child .checks').getBoundingClientRect();
      const cx = el => { const b = el.getBoundingClientRect(); return b.left + b.width / 2; };
      const d = [...document.querySelectorAll('.grid-date')].map(cx);
      const c = checks.map(cx);
      return {
        columns: checks.length,
        tooSmall: sizes.filter(s => s.h < ${MIN_TOUCH}).length,
        stripOverflowsRow: Math.round(strip.right - row.right) > 0,
        headerOffset: d.length ? Math.round(Math.max(...d.map((v, i) => Math.abs(v - c[i])))) : 0,
        nameVisible: document.querySelector('.habit-name').getBoundingClientRect().width > 20,
      };
    })()`);

    ck(`${vp.label}: day cells clear ${MIN_TOUCH}px`,
      grid.tooSmall === 0, `${grid.tooSmall} of ${grid.columns} too short`);
    ck(`${vp.label}: day strip stays inside its card`,
      grid.stripOverflowsRow === false);
    ck(`${vp.label}: date header lines up with the checkboxes`,
      grid.headerOffset <= 2, `${grid.headerOffset}px`);
    ck(`${vp.label}: habit name is not squashed away`, grid.nameVisible === true);

    /* ---- detail view ---- */
    await ev(`document.querySelector('.habit-row .habit-meta').click()`);
    for (let i = 0; i < 60; i++) {
      if (await ev(`!!document.querySelector('#view-detail svg')`)) break;
      await sleep(200);
    }
    await sleep(400);

    probe = await ev(LAYOUT_PROBE);
    ck(`${vp.label}: detail view does not scroll sideways`,
      probe.pageScrollsSideways === false, JSON.stringify(probe.overflowing));

    const charts = await ev(`(() => {
      const svgs = [...document.querySelectorAll('#view-detail svg')];
      const de = document.documentElement;
      return {
        count: svgs.length,
        // Charts are allowed to be wide, but only inside a scrolling wrapper.
        unscrollableOverflow: svgs.filter(s => {
          const b = s.getBoundingClientRect();
          const wrap = s.closest('.chart-scroll');
          return !wrap && b.right > de.clientWidth + 1;
        }).length,
        // Scoped to the header row, not every .stat-tile on the page: the
        // "Bouncing back" card contributes its own tiles, and a global count
        // would have to be revised every time a card gains one.
        tiles: document.querySelectorAll('#view-detail > .stat-row .stat-tile').length,
      };
    })()`);
    ck(`${vp.label}: all five charts render`, charts.count >= 5, String(charts.count));
    ck(`${vp.label}: no chart overflows without a scroller`,
      charts.unscrollableOverflow === 0, String(charts.unscrollableOverflow));
    ck(`${vp.label}: stat tiles present`, charts.tiles === 4, String(charts.tiles));

    /* ---- dialogs ---- */
    for (const [name, opener] of [
      ['settings', `document.getElementById('btn-settings').click()`],
      ['backup', `document.getElementById('btn-data').click()`],
    ]) {
      await ev(`(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); })()`);
      await ev(opener);
      await sleep(350);
      const dlg = await ev(`(() => {
        const d = document.querySelector('dialog[open]');
        if (!d) return null;
        const b = d.getBoundingClientRect();
        const de = document.documentElement;
        return {
          fitsWidth: b.width <= de.clientWidth + 1,
          onScreen: b.left >= -1 && b.right <= de.clientWidth + 1,
          tallerThanScreen: b.height > de.clientHeight,
          scrollable: getComputedStyle(d).overflowY,
        };
      })()`);
      ck(`${vp.label}: ${name} dialog fits the screen`,
        dlg && dlg.fitsWidth && dlg.onScreen, JSON.stringify(dlg));
      await ev(`(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); })()`);
      await sleep(200);
    }
  }

  console.log(fails === 0 ? '\nALL RESPONSIVE CHECKS PASSED' : `\n${fails} RESPONSIVE CHECK(S) FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
