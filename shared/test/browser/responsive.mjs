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
import { seedCategorySpread } from './fixtures.mjs';

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

  // #66: an icon on the first habit, seeded here rather than by growing
  // `fixtures.mjs` — same reasoning as `seedForSearch`, and PUT REPLACES a
  // habit whole, so the write carries the fetched row back with `icon` added
  // rather than a bare `{icon}`.
  await ev(`(async()=>{
    const hs = await (await fetch('/api/habits')).json();
    const h = hs[0];
    await fetch('/api/habits/'+h.id, {method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({...h, icon: '\u{1F9D8}'})});
  })()`);

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
      const icon = document.querySelector('.habit-row:first-child .habit-icon');
      const nameText = document.querySelector('.habit-row:first-child .habit-name-text');
      return {
        columns: checks.length,
        tooSmall: sizes.filter(h => h < ${MIN_TOUCH}).length,
        stripOverflowsRow: Math.round(strip.right - row.right) > 0,
        nameWidth: Math.round(document.querySelector('.habit-name').getBoundingClientRect().width),
        iconWidth: icon ? Math.round(icon.getBoundingClientRect().width) : null,
        nameTextWidth: nameText ? Math.round(nameText.getBoundingClientRect().width) : null,
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

    // #66: the icon actually rendered on this row — without this the two
    // checks below would pass vacuously on a row that never grew one.
    ck(`${vp.label} @ gridDays=${maxDays}: the icon is on the row`,
      grid.iconWidth !== null, JSON.stringify(grid));
    // The invariant is "fixed-width column", not "leaves the name enough
    // room" — the latter (below) is already guaranteed by the wrap below
    // 640px and the column ladder above it, with room to spare, so it does
    // not move under this mutation. 40px is one grapheme's line box; nothing
    // here is proportional to the container. Measured at 360px: `.habit-name`
    // is 283px wide, so `.habit-icon { width: 30% }` resolves to ~85px — over
    // double the cap — which is what actually catches `flex: none` regressing
    // to a percentage width.
    ck(`${vp.label} @ gridDays=${maxDays}: the icon column is fixed-width, not proportional`,
      grid.iconWidth <= 40, `${grid.iconWidth}px`);
    // The weaker half, kept for a future change that genuinely squeezes the
    // name out — proved insensitive to the `.habit-icon` width mutation above
    // (the wrap/ladder leave far more than 20px of headroom regardless), so
    // it is not what guards the layout; the fixed-width check above is.
    ck(`${vp.label} @ gridDays=${maxDays}: habit name text is not squashed away`,
      grid.nameTextWidth > 20, `${grid.nameTextWidth}px`);
  }

  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({gridDays:'auto'})}).then(r=>r.ok)`);

  /* ---------- the grouped dashboard (#65), at every width ---------- */
  //
  // A section header is a row shape `#grid` never drew before this feature —
  // its own padding, its coloured left border and its count text — and none
  // of the checks above ever turn `groupByCategory` on, so this is the only
  // pass that could catch it overflowing a narrow phone. Both habits
  // assigned into a category below are real fixture habits the seed logs
  // over 60 days, so `categorySummaries` carries a real mean and a real
  // `.category-section-figure` is on the row this probes — an empty (`—`)
  // header would tell nothing about the figures' own width.
  console.log('\n--- grouped dashboard ---');
  await ev(`(async()=>{
    const cats = await (await fetch('/api/categories')).json();
    for (const c of cats) await fetch('/api/categories/' + c.id, { method: 'DELETE' });
    const a = await (await fetch('/api/categories', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Health', color: '#10b981' }) })).json();
    const b = await (await fetch('/api/categories', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Work', color: '#f59e0b' }) })).json();
    const habits = await (await fetch('/api/habits')).json();
    // One habit into each category; the rest stay Uncategorised, so that
    // trailing section actually has something in it too.
    await fetch('/api/habits/' + habits[0].id, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...habits[0], category_id: a.id }) });
    await fetch('/api/habits/' + habits[1].id, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...habits[1], category_id: b.id }) });
    await fetch('/api/settings', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupByCategory: true }) });
  })()`);

  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId);
    await send('Page.navigate', { url: APP }, sessionId);
    for (let i = 0; i < 80; i++) {
      if (await ev(`document.querySelectorAll('#grid .category-section-header').length >= 3`).catch(() => 0)) break;
      await sleep(200);
    }
    await sleep(400);

    const probe = await ev(LAYOUT_PROBE);
    ck(`${vp.label}: grouped dashboard does not scroll sideways`,
      probe.pageScrollsSideways === false, JSON.stringify(probe.overflowing));
    ck(`${vp.label}: nothing overflows the viewport while grouped`,
      probe.overflowing.length === 0, JSON.stringify(probe.overflowing));

    const headers = await ev(
      `document.querySelectorAll('#grid .category-section-header').length`);
    ck(`${vp.label}: both categories plus the trailing Uncategorised section are drawn`,
      headers === 3, String(headers));

    // The probe above is only meaningful for this feature if a real figure
    // was actually on the row it measured — logged habits, not filtered, not
    // archived, so `summarised` is true and `categorySummaries` was fetched.
    const figures = await ev(
      `document.querySelectorAll('#grid .category-section-figure').length`);
    ck(`${vp.label}: at least one section drew a summary figure to be measured`,
      figures > 0, String(figures));
  }

  /* ---------- the habit dialog's category manage row (issue #65 step 2), at
     every width ---------- */
  //
  // Buttons, not drag: the ↑/↓ pair this issue adds share the row with the
  // swatch, the name and the existing ✎/✕, and `.category-manage-name`'s own
  // `flex: 1; min-width: 0` is the one thing meant to absorb a narrow
  // screen — everything else in the row is `flex: none`. The two categories
  // (Health, Work) created for the grouped-dashboard block just above are
  // still on the account, which is what `canReorder` needs before either
  // arrow is drawn at all.
  console.log('\n--- habit dialog: category manage row ---');

  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId);
    await send('Page.navigate', { url: APP }, sessionId);
    for (let i = 0; i < 80; i++) {
      if (await ev(`!!document.getElementById('btn-new') && !document.getElementById('btn-new').hidden`)
        .catch(() => false)) break;
      await sleep(200);
    }
    await ev(`document.getElementById('btn-new').click()`);
    for (let i = 0; i < 80; i++) {
      if (await ev(`document.querySelectorAll('#category-manage .category-manage-row').length >= 2`)
        .catch(() => false)) break;
      await sleep(200);
    }
    await sleep(200);

    // FIT, not touch size — see the comment on the assertion below. Every
    // focusable control in a row (swatch excluded; it is not a button) has
    // its right edge measured against `.category-manage`'s own client width,
    // which is the row's actual container (the `<ul>`), not the dialog.
    const rows = await ev(`(() => {
      const manage = document.querySelector('.category-manage');
      const manageRight = manage.getBoundingClientRect().right;
      return [...manage.querySelectorAll('.category-manage-row')].map((r) => {
        const controls = [...r.querySelectorAll('button, input')];
        const rightmost = controls.reduce(
          (max, el) => Math.max(max, el.getBoundingClientRect().right), 0);
        const name = r.querySelector('.category-manage-name');
        return {
          overflowsBy: Math.round(rightmost - manageRight),
          nameWidth: name ? Math.round(name.getBoundingClientRect().width) : 0,
        };
      });
    })()`);

    ck(`${vp.label}: every manage row's controls fit inside .category-manage`,
      rows.length > 0 && rows.every((r) => r.overflowsBy <= 1), JSON.stringify(rows));
    // `MIN_TOUCH` (44px) is deliberately not asked here: `.btn-icon`'s
    // existing `padding: 7px 10px` for ✎ and ✕ is already smaller than that,
    // so a touch-size assertion would fail on controls this change did not
    // add. This is a FIT check — nothing pushed past the row's own edge —
    // and a non-zero name width, so the row did not "fit" by squeezing the
    // name away to nothing.
    ck(`${vp.label}: the category name still has real width, not squeezed away`,
      rows.length > 0 && rows.every((r) => r.nameWidth > 0), JSON.stringify(rows));

    await ev(`document.getElementById('dialog-cancel').click()`);
    await sleep(150);
  }

  await ev(`(async()=>{
    await fetch('/api/settings', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupByCategory: false }) });
    const cats = await (await fetch('/api/categories')).json();
    for (const c of cats) await fetch('/api/categories/' + c.id, { method: 'DELETE' });
  })()`);

  /* ---------- the category comparison (#65), at every width ---------- */
  //
  // A grid of cards, each holding a chart sized from the card it sits in — a
  // shape no other view in the app has, and the one place `svg.chart {
  // max-width: 100% }` can silently scale a whole drawing down rather than
  // clipping it. Nothing above ever opens `#/categories`, so this is the only
  // pass that could catch either failure on a phone.
  console.log('\n--- category comparison ---');
  await seedCategorySpread({ base: APP });

  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId);
    // Back to the dashboard and in through the button, rather than navigating
    // straight to `#/categories` at each width. A second `Page.navigate` to a
    // URL that differs only in its FRAGMENT is a same-document navigation and
    // does not re-render anything — so every width after the first measured
    // the previous one's charts, and the SVGs drawn for a 768px tablet then
    // read as scaled down inside a 1440px desktop's narrower two-column card.
    // A spurious failure that looked exactly like the real defect the
    // `downscaled` check below is for.
    await send('Page.navigate', { url: APP }, sessionId);
    for (let i = 0; i < 100; i++) {
      const ready = await ev(`!!document.querySelector('#grid .habit-row')
        && document.getElementById('btn-compare').hidden === false`).catch(() => 0);
      if (ready) break;
      await sleep(200);
    }
    await ev(`document.getElementById('btn-compare').click()`);

    // **The view unhidden AND the first card laid out**, not a card count.
    // `render()` unhides the container before `replaceChildren()` empties it,
    // so a previous render's cards are still in it — a poll that counts
    // `.compare-card` matches those and returns before this render has laid
    // anything out, which is how a zero-width page comes to be measured.
    for (let i = 0; i < 100; i++) {
      const ready = await ev(`(() => {
        const view = document.getElementById('view-categories');
        const first = view && !view.hidden && view.querySelector('.compare-card');
        return !!first && first.getBoundingClientRect().width > 0;
      })()`).catch(() => 0);
      if (ready) break;
      await sleep(200);
    }
    await sleep(300);

    const probe = await ev(LAYOUT_PROBE);
    ck(`${vp.label}: the comparison does not scroll sideways`,
      probe.pageScrollsSideways === false, JSON.stringify(probe.overflowing));
    ck(`${vp.label}: nothing overflows the viewport on the comparison`,
      probe.overflowing.length === 0, JSON.stringify(probe.overflowing));

    const compare = await ev(`(() => {
      const de = document.documentElement;
      const cards = [...document.querySelectorAll('#view-categories .compare-card')];
      const svgs = [...document.querySelectorAll('#view-categories svg')];
      return {
        cards: cards.length,
        narrowest: Math.min(...cards.map(c => Math.round(c.getBoundingClientRect().width))),
        outside: cards.filter(c => {
          const b = c.getBoundingClientRect();
          return b.left < -1 || b.right > de.clientWidth + 1;
        }).length,
        charts: svgs.length,
        // The silent downscale innerWidthOf exists to prevent: an SVG asked
        // for more width than its card has is SCALED, not clipped, so the whole
        // drawing shrinks with nothing overflowing to say so. A chart rendered
        // narrower than the width it asked for is that, and nothing else.
        downscaled: svgs.filter(s => {
          const asked = Number(s.getAttribute('width'));
          return asked - s.getBoundingClientRect().width > 1;
        }).length,
        // A member name is free text and one long enough to widen its track
        // would push the grid past the viewport; .compare-member-name
        // ellipsises for that reason, so it must not be the widest thing here.
        namesClipped: [...document.querySelectorAll('.compare-member-name')]
          .filter(n => n.getBoundingClientRect().right > de.clientWidth + 1).length,
      };
    })()`);

    ck(`${vp.label}: every category is drawn as a card`,
      compare.cards === 5, `${compare.cards} cards`);
    ck(`${vp.label}: no card sits outside the viewport`,
      compare.outside === 0, `${compare.outside} of ${compare.cards}`);
    ck(`${vp.label}: the cards have real width`,
      compare.narrowest > 200, `narrowest ${compare.narrowest}px`);
    ck(`${vp.label}: every category with a strength drew its chart`,
      compare.charts === 3, `${compare.charts} charts`);
    ck(`${vp.label}: no chart was silently scaled down inside its card`,
      compare.downscaled === 0, `${compare.downscaled} of ${compare.charts}`);
    ck(`${vp.label}: no member name spills off the screen`,
      compare.namesClipped === 0, String(compare.namesClipped));
  }

  // Cleaned up for the reason the grouped block above cleans up its own: the
  // top-bar Compare button exists only for an account that HAS a category, so
  // leaving these behind puts a fifth control in the top bar for the next
  // standalone run — including this suite's own dashboard checks, which are
  // the ones measuring whether that bar fits a 360px phone.
  await ev(`(async()=>{
    const cats = await (await fetch('/api/categories')).json();
    for (const c of cats) await fetch('/api/categories/' + c.id, { method: 'DELETE' });
  })()`);

  console.log(fails === 0 ? '\nALL RESPONSIVE CHECKS PASSED' : `\n${fails} RESPONSIVE CHECK(S) FAILED`);
} catch (e) {
  console.error('ERR', e.message); fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
