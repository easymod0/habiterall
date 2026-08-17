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
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000';
const PORT = devtoolsPort(9303);

/** Smallest widely-used phone, a large phone, a tablet, and a desktop. */
const VIEWPORTS = [
  { label: 'small phone', w: 360, h: 740, mobile: true },
  { label: 'phone', w: 390, h: 844, mobile: true },
  { label: 'tablet', w: 768, h: 1024, mobile: true },
  { label: 'desktop', w: 1440, h: 900, mobile: false },
];

/** 44px is the accessibility minimum for a touch target. */
const MIN_TOUCH = 44;

/**
 * How many habits this suite needs before there is a search row to measure.
 *
 * `dashboard.js`'s `SEARCH_FROM` is 6 and the shared fixtures are 4, so the
 * control was never on screen here at all: every check below ran against a
 * dashboard that structurally could not have one, and the row could have
 * overflowed a 360px phone in silence.
 *
 * Seeded here rather than by growing `fixtures.mjs`, deliberately. That file is
 * the input to every browser suite — the runner resets it before each — and
 * several of them assert counts or index rows positionally, so raising it past
 * six to serve this suite changes what nine others are looking at.
 */
const SEEDED_HABITS = 8;

/** Names long enough to compete with the grid for width on a small phone. */
async function seedForSearch() {
  const have = await (await fetch(`${APP}/api/habits`)).json();
  for (let i = have.length; i < SEEDED_HABITS; i++) {
    await fetch(`${APP}/api/habits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Seeded habit number ${i + 1}`, type: 'boolean',
        description: 'seeded by responsive.mjs to raise the habit count',
      }),
    });
  }
}

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
  await seedForSearch();
  const url = await devtoolsUrl(PORT, chrome);
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

    // The search row sits above the grid and competes with nothing, which is
    // exactly why it is worth measuring rather than assuming: it is the one
    // control that appears only once an account is big enough, so it would
    // otherwise reach a phone having been laid out on a desktop alone. The
    // probe above sees it too now, for free, since it is on screen at all.
    const search = await ev(`(() => {
      const row = document.getElementById('search-row');
      const box = document.getElementById('habit-search');
      const b = box.getBoundingClientRect();
      const de = document.documentElement;
      return {
        shown: !row.hidden,
        height: Math.round(b.height),
        width: Math.round(b.width),
        inside: b.left >= -1 && b.right <= de.clientWidth + 1,
      };
    })()`);
    ck(`${vp.label}: the search box is on screen and inside the viewport`,
      search.shown && search.inside, JSON.stringify(search));
    ck(`${vp.label}: the search box clears ${MIN_TOUCH}px`,
      search.height >= MIN_TOUCH, `${search.height}px`);

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
    // Backup is reached THROUGH settings now — the top bar no longer carries
    // it — and it opens stacked on top rather than replacing it. So each step
    // measures the LAST open dialog, which is the one actually in front of the
    // user, and the teardown closes however many are open.
    const closeAll =
      `[...document.querySelectorAll('dialog[open]')].reverse().forEach(d => d.close())`;
    for (const [name, opener] of [
      ['settings', `document.getElementById('btn-settings').click()`],
      ['backup', `document.getElementById('btn-settings').click();`
        + ` document.getElementById('settings-backup').click()`],
    ]) {
      await ev(`(() => { ${closeAll}; })()`);
      await ev(opener);
      await sleep(350);
      const dlg = await ev(`(() => {
        const open = document.querySelectorAll('dialog[open]');
        const d = open[open.length - 1];
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
      await ev(`(() => { ${closeAll}; })()`);
      await sleep(200);
    }
  }

  /* ---- the day-column setting at its maximum, at every width ---- */
  //
  // #112 asked for this pass by name: `gridDays` can only ever request FEWER
  // columns than the viewport fits, so at its largest value every assertion
  // above must still hold. Without it the option reintroduces exactly the
  // layout bug this suite was written to catch — a 14-column strip needing
  // 668px of a 698px row, with nothing left for the habit name.
  //
  // The maximum is read from SETTING_VALUES rather than written as '14', so
  // widening the option list has to come back through here.
  console.log('\n--- gridDays at its maximum ---');
  const { SETTING_VALUES } = await import('../../src/validate.js');
  const maxDays = SETTING_VALUES.gridDays
    .filter((v) => v !== 'auto')
    .reduce((max, v) => (Number(v) > Number(max) ? v : max));

  await send('Page.navigate', { url: APP }, sessionId);
  await sleep(800);
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({gridDays:'${maxDays}'})}).then(r=>r.ok)`);

  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId);
    await send('Page.navigate', { url: APP }, sessionId);
    for (let i = 0; i < 80; i++) {
      if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
      await sleep(200);
    }
    await sleep(500);

    const probe = await ev(LAYOUT_PROBE);
    ck(`${vp.label} @ gridDays=${maxDays}: nothing overflows the viewport`,
      probe.overflowing.length === 0 && probe.pageScrollsSideways === false,
      JSON.stringify(probe.overflowing));

    const grid = await ev(`(() => {
      const checks = [...document.querySelectorAll('.habit-row:first-child .check')];
      const sizes = checks.map(c => c.getBoundingClientRect().height);
      const row = document.querySelector('.habit-row').getBoundingClientRect();
      const strip = document.querySelector('.habit-row:first-child .checks').getBoundingClientRect();
      return {
        columns: checks.length,
        tooSmall: sizes.filter(h => h < ${MIN_TOUCH}).length,
        stripOverflowsRow: Math.round(strip.right - row.right) > 0,
        nameWidth: Math.round(document.querySelector('.habit-name').getBoundingClientRect().width),
      };
    })()`);

    ck(`${vp.label} @ gridDays=${maxDays}: day cells clear ${MIN_TOUCH}px`,
      grid.tooSmall === 0, `${grid.tooSmall} of ${grid.columns} too short`);
    ck(`${vp.label} @ gridDays=${maxDays}: day strip stays inside its card`,
      grid.stripOverflowsRow === false);
    // The failure the cap exists to prevent, asserted directly: the setting
    // must not be able to squeeze the name out of the row.
    ck(`${vp.label} @ gridDays=${maxDays}: habit name is not squashed away`,
      grid.nameWidth > 20, `${grid.nameWidth}px`);
  }

  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({gridDays:'auto'})}).then(r=>r.ok)`);

  console.log(fails === 0 ? '\nALL RESPONSIVE CHECKS PASSED' : `\n${fails} RESPONSIVE CHECK(S) FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
