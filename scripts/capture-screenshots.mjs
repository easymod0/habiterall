/**
 * Regenerate the README's web screenshots from the real app.
 *
 *   node scripts/capture-screenshots.mjs              # all of them
 *   node scripts/capture-screenshots.mjs dashboard    # a subset, by name
 *   node scripts/capture-screenshots.mjs --keep       # leave the server up
 *
 * The README says "every screenshot in this README is the real app, with
 * sample data", and that claim is only worth making if it is cheap to remake.
 * So this starts a throwaway personal-edition server, seeds it, drives Chrome
 * over CDP and writes `docs/screenshots/*.png` — no hand-cropping, and the
 * next refresh is one command rather than an afternoon.
 *
 * **The demo data is deterministic**, from a seeded PRNG rather than
 * `Math.random`. A screenshot set is compared by eye against the last one, and
 * data that moves between runs makes every image differ for no reason —
 * `scripts/seed.js` is random because a demo install wants variety, which is
 * the opposite requirement.
 *
 * Two things are captured rather than composed. The **clip** comes from a real
 * `getBoundingClientRect()`, so a card that grows a row is still framed; and
 * `deviceScaleFactor: 2`, so the PNGs are legible on the display most people
 * read GitHub on. Nothing here resizes or crops afterwards.
 *
 * The Android shots are not here — they need an emulator, an APK and the
 * notification shade, none of which a CDP session can reach. `docs/screenshots`
 * holds both sets and `shared/test/readme-assets.test.js` checks both are
 * referenced.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { closeChrome, devtoolsUrl, launchChrome, waitUntil } from
  '../shared/test/browser/chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OUT = join(root, 'docs', 'screenshots');

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const only = argv.filter((a) => !a.startsWith('--'));

// Not :3000 and not the browser fleet's :3200 range — this is meant to be
// runnable while a dev server is up, and a capture against somebody else's
// data is a mistake you only notice after committing the PNG.
const PORT = Number(process.env.HABITERALL_SHOT_PORT) || 3280;
const BASE = `http://localhost:${PORT}`;
const DEVTOOLS = Number(process.env.DEVTOOLS_PORT) || 9410;

/* ------------------------------------------------------------------ data -- */

/**
 * The habits the README shows.
 *
 * Six of them, deliberately: the search box appears at six (`searchcheck`),
 * so a shorter list would show a dashboard the README describes and nobody
 * running the app would see. Between them they cover every shape rendered
 * differently — a boolean daily, a boolean 3x/7, a measurable at-least, and
 * two at-most habits shown as things to avoid — and every one carries an icon,
 * because the icon is what the hero shot is partly there to show.
 */
const HABITS = [
  {
    name: 'Meditate', icon: '🧘', description: 'Ten minutes after waking',
    type: 'boolean', color: '#8b5cf6', freq_numerator: 1, freq_denominator: 1,
    reminder_time: '07:30', reminder_message: 'Did you sit for ten minutes?',
    // A strong daily habit with occasional single-day lapses: this is the one
    // the statistics and bouncing-back shots are taken from, and it has to
    // have both a long streak and enough recoveries for the survival curve to
    // have a shape. The recent fortnight is unbroken on purpose — a hero shot
    // whose first row reads "streak 1" is describing a habit nobody is keeping.
    roll: (rnd, dow, i) => (i < 14 || rnd() < 0.92 ? 2 : 0),
  },
  {
    name: 'Gym', icon: '🏋️', description: 'Strength training',
    type: 'boolean', color: '#f59e0b', freq_numerator: 3, freq_denominator: 7,
    reminder_time: '18:00',
    roll: (rnd, dow) => ([1, 3, 5].includes(dow) && rnd() < 0.85 ? 2 : 0),
  },
  {
    name: 'Read', icon: '📚', description: 'Pages before bed',
    type: 'numerical', unit: 'pages', target_value: 20, target_type: 'at_least',
    color: '#0ea5e9', freq_numerator: 1, freq_denominator: 1,
    reminder_time: '21:30',
    roll: (rnd) => Math.round(rnd() * 34),
  },
  {
    name: 'Water', icon: '💧', description: 'Stay hydrated',
    type: 'numerical', unit: 'glasses', target_value: 8, target_type: 'at_least',
    color: '#3b82f6', freq_numerator: 1, freq_denominator: 1,
    reminder_message: 'How many glasses of water did you drink today?',
    roll: (rnd) => 4 + Math.floor(rnd() * 6),
  },
  {
    name: 'Coffee', icon: '☕', description: 'Two cups, no more',
    type: 'numerical', unit: 'cups', target_value: 2, target_type: 'at_most',
    show_as: 'avoid', color: '#f97316', freq_numerator: 1, freq_denominator: 1,
    roll: (rnd) => (rnd() < 0.78 ? Math.floor(rnd() * 3) : 3),
  },
  {
    name: 'Late-night snacks', icon: '🌙', description: 'Nothing after 9pm',
    type: 'numerical', unit: 'snacks', target_value: 0, target_type: 'at_most',
    show_as: 'avoid', color: '#10b981', freq_numerator: 1, freq_denominator: 1,
    roll: (rnd) => (rnd() < 0.8 ? 0 : 1),
  },
];

/**
 * How much history to seed.
 *
 * Over a year, because the CALENDAR is what sets this rather than the strength
 * curve. The heatmap's default zoom shows about fourteen months, so 170 days
 * of history drew a card that was two thirds empty grey — an accurate picture
 * of the fixture and a misleading one of the feature.
 */
const DAYS = 430;

/**
 * The settings every shot starts from.
 *
 * All three server-sent destinations are on so the Notifications section shows
 * its whole shape — the Discord fields, the ntfy fields and the reminder
 * timezone, which is hidden until a destination the server delivers is picked.
 * The ids are the registry's own placeholder values, so nothing here is a
 * credential and nothing reads as one.
 */
const SETTINGS = {
  theme: 'dark',
  // On, though it ships off. It is what puts a third action in the Android
  // notification, and that shade shot is one of the README's images — a
  // reminder offering Yes and No only is a picture of the setting, not of the
  // feature the section is about.
  skipDays: true,
  notifyChannels: ['android', 'discord', 'ntfy'],
  discordChannelId: '123456789012345678',
  ntfyTopicUrl: 'https://ntfy.sh/habiterall-demo',
  notifyTimezone: 'Europe/London',
};

/** mulberry32 — small, seeded, and good enough for plausible-looking history. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
};

/** Create the habits and their history. Returns them keyed by name. */
async function seed() {
  const created = {};
  for (const spec of HABITS) {
    const { roll, ...body } = spec;
    created[spec.name] = await api('/habits', { method: 'POST', body: JSON.stringify(body) });
  }

  for (const spec of HABITS) {
    // One stream per habit, so adding a habit does not reshuffle the history
    // of the ones before it.
    const rnd = rng(spec.name.length * 7919 + spec.name.charCodeAt(0));
    const id = created[spec.name].id;

    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const value = spec.roll(rnd, d.getDay(), i);

      // A boolean "no" is stored as absence, which is what a tap does. An
      // at-most habit's 0 is the opposite — a recorded clean day, and the
      // whole point of the avoid rendering — so it is written.
      if (spec.type === 'boolean' && value === 0) continue;
      await api(`/habits/${id}/entries/${iso(d)}`,
        { method: 'PUT', body: JSON.stringify({ value }) });
    }
  }

  await api('/settings', { method: 'PUT', body: JSON.stringify(SETTINGS) });
  return created;
}

/* ------------------------------------------------------------------ shots -- */

/**
 * What to capture.
 *
 * `viewport` is CSS pixels; every PNG comes out at twice that. `from` and `to`
 * frame the image — a CSS selector, or `card:<title>` for a card on a habit's
 * page, which is how the detail view is addressed since its cards carry no ids
 * and their ORDER is a setting.
 *
 * `hideChrome` is not cosmetic. `.topbar` is `position: sticky`, and
 * `captureBeyondViewport` re-renders the page at the size of the clip — so a
 * sticky bar sticks to the top of the CLIP, painting itself over whatever the
 * shot is of. Every card-only image had the brand and the New habit button
 * across it, and the card's own title hidden underneath. Dropping the bar
 * before measuring is what makes a card shot a card.
 */
const SHOTS = (habits) => [
  {
    name: 'dashboard',
    what: 'the hero: six habits with their icons, in dark',
    viewport: [1280, 900],
    url: '/',
    // From the top bar, not from the list: the gear and the ◐ / ☀ / ☾ button
    // are both things the README points at in prose, and a hero cropped below
    // them shows an app with no way to reach either.
    from: 'header.topbar',
    to: 'main#view-list',
  },
  {
    name: 'dashboard-light',
    what: 'the same dashboard in light, for the theme bullet',
    viewport: [1280, 900],
    theme: 'light',
    url: '/',
    from: 'header.topbar',
    to: 'main#view-list',
  },
  {
    name: 'statistics',
    what: "a habit's page: the tiles, the strength curve, the calendar, the streaks",
    viewport: [1280, 900],
    url: `/#/habit/${habits.Meditate.id}`,
    ready: '#view-detail .card',
    hideChrome: true,
    // From the habit's own heading — the name, the icon and the four figures —
    // down to the streaks. Not the whole page: all nine cards is ~4000px, and
    // an image nobody can read is not evidence of anything.
    from: '#view-detail',
    to: 'card:Best streaks',
  },
  {
    name: 'bouncing-back',
    what: 'the Bouncing back card on its own',
    viewport: [1280, 1000],
    url: `/#/habit/${habits.Meditate.id}`,
    ready: '#view-detail .card',
    hideChrome: true,
    from: 'card:Bouncing back',
  },
  {
    name: 'reminder-time',
    what: "the habit's edit screen: its icon, its goal, and the reminder it sends",
    viewport: [1280, 1600],
    url: `/#/habit/${habits.Meditate.id}`,
    ready: '#view-detail .card',
    open: 'edit-dialog',
    // The whole dialog rather than the reminder fieldset alone. Two reasons:
    // it is the only shot that shows where a habit's ICON is set, and it sits
    // beside `notifications.png` in the README — a 420px-wide pair reads as
    // one figure only if both halves are portrait, and the fieldset on its own
    // is a wide strip.
    from: '#habit-dialog',
    // No padding at all: the dialog floats over the habit's own calendar, and
    // even ten pixels of it is a band of bright purple squares down both edges
    // of the image that reads as a botched crop.
    pad: 0,
  },
  {
    name: 'notifications',
    what: 'the Notifications settings, with Discord and ntfy both on',
    viewport: [1280, 1400],
    url: '/',
    open: 'settings',
    from: '[data-section="Notifications"]',
  },
  {
    name: 'settings-cards',
    what: "the Statistics settings, where a habit's cards are ticked and reordered",
    viewport: [1280, 1400],
    url: '/',
    open: 'settings',
    from: '[data-section="Statistics"]',
  },
  {
    name: 'dashboard-mobile',
    what: 'the dashboard at phone width, as the installed PWA looks',
    viewport: [390, 760],
    mobile: true,
    url: '/',
    from: 'header.topbar',
    to: 'main#view-list',
  },
];

/* ------------------------------------------------------------------- run -- */

const dataDir = mkdtempSync(join(tmpdir(), 'habiterall-shots-'));
let server;
let chrome;
const profile = mkdtempSync(join(tmpdir(), 'habshot-chrome-'));

function stop() {
  for (const p of [server]) {
    try {
      if (p && process.platform !== 'win32' && p.pid) process.kill(-p.pid, 'SIGKILL');
      else p?.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* fine */ }
}
if (!keep) {
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { stop(); process.exit(130); });
  }
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) { last = err?.message ?? String(err); }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${BASE} never became healthy (${last})`);
}

server = spawn(process.execPath, ['src/server.js'], {
  cwd: join(root, 'habiterall-personal'),
  stdio: 'ignore',
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    PORT: String(PORT),
    HABITERALL_DB: join(dataDir, 'shots.db'),
    HABITERALL_AUTH: 'off',
    HABITERALL_RATE_LIMIT: 'off',
    // Nothing here should ever reach a real destination: the settings below
    // name a Discord channel and an ntfy topic, and the tick would try both.
    HABITERALL_NOTIFY: 'off',
  },
});

await waitForServer();
const habits = await seed();
console.log(`seeded ${Object.keys(habits).length} habits over ${DAYS} days on ${BASE}`);

chrome = launchChrome(DEVTOOLS, profile);
let ws;
let nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++;
  pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  const url = await devtoolsUrl(DEVTOOLS, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return r.result.value;
  };

  const wanted = SHOTS(habits).filter((s) => !only.length || only.includes(s.name));
  if (!wanted.length) {
    throw new Error(`no shot matches ${only.join(', ')}. Names: `
      + SHOTS(habits).map((s) => s.name).join(', '));
  }

  for (const shot of wanted) {
    const [w, h] = shot.viewport;
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 2, mobile: !!shot.mobile,
    }, sessionId);

    // The theme is an account setting, so it is switched on the server rather
    // than in the page: that is the same path a user takes, and it means the
    // first paint is already right instead of flipping after boot.
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({ theme: shot.theme ?? 'dark' }),
    });

    // `about:blank` first, every time. Two shots in a row can differ only in
    // their fragment (`/` then `/#/habit/3`), and `Page.navigate` treats that
    // as a same-document hop: the router moves, nothing re-boots, and the
    // theme this shot just wrote to the server is never read — so the second
    // shot is captured under the first one's palette. Dropping the document
    // makes every capture a cold boot, which is also the state being shown.
    await send('Page.navigate', { url: 'about:blank' }, sessionId);
    await send('Page.navigate', { url: `${BASE}${shot.url}` }, sessionId);
    const ready = shot.ready ?? '.habit-row';
    await waitUntil(ev,
      `!!(document.querySelector(${JSON.stringify(ready)})`
      + ` && document.documentElement.dataset.theme === ${JSON.stringify(shot.theme ?? 'dark')})`,
      { what: `${shot.name}: ${ready} under the ${shot.theme ?? 'dark'} theme` });

    if (shot.open === 'settings') {
      await ev(`document.querySelector('#btn-settings').click()`);
      await waitUntil(ev, `!!document.querySelector('#settings-dialog[open] .data-section')`,
        { what: 'the settings dialog' });
    }
    if (shot.open === 'edit-dialog') {
      await ev(`[...document.querySelectorAll('#view-detail button')]`
        + `.find((b) => b.textContent.trim() === 'Edit').click()`);
      await waitUntil(ev, `!!document.querySelector('#habit-dialog[open] #reminder-field')`,
        { what: 'the habit dialog' });
    }

    // Charts are drawn from a fetch the view makes after it renders, and an
    // SVG with no <path> in it is a card that will change under the camera.
    await waitUntil(ev, `[...document.querySelectorAll('.card svg')]`
      + `.every((s) => s.childElementCount > 0)`,
      { what: 'every chart to have drawn', timeoutMs: 10_000 })
      .catch(() => { /* a shot with no charts in it has nothing to wait for */ });

    const clip = await ev(rectExpression(shot));
    if (!clip) throw new Error(`${shot.name}: nothing matched its clip selector`);

    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 2 },
      // `captureBeyondViewport` re-renders the page at the size of the clip,
      // and that re-render does NOT preserve the scroll position of a nested
      // scroll container. The settings dialog is one: the rect was measured
      // with Notifications scrolled to the top of it, the capture re-rendered
      // it scrolled back to Statistics, and the PNG showed the section ABOVE
      // the one asked for — correctly framed, on the wrong content. So a shot
      // that opened a dialog is captured from the viewport as it stands, which
      // is why those shots carry a viewport tall enough to hold them whole.
      captureBeyondViewport: !shot.open,
    }, sessionId);

    const file = join(OUT, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  ${shot.name}.png  ${Math.round(clip.width * 2)}x${Math.round(clip.height * 2)}`
      + `  — ${shot.what}`);
  }
} finally {
  await closeChrome({ chrome, port: DEVTOOLS, profile });
  if (keep) console.log(`server left running on ${BASE} (database under ${dataDir})`);
  else stop();
}

/**
 * The expression that measures a shot, evaluated in the page.
 *
 * Built as a string rather than passed as a function because CDP's
 * `Runtime.evaluate` takes source, and a shot's framing is three different
 * questions: one element, a run of cards between two titles, or one element
 * through to the end of another. All three answer in CSS pixels relative to
 * the page, which is what `Page.captureScreenshot`'s clip wants.
 *
 * The padding is deliberate and asymmetric-free: an element flush to the edge
 * of a PNG reads as a crop that went wrong, and the dialog sections in
 * particular sit on a surface whose colour is part of what the shot shows.
 */
function rectExpression(shot) {
  const pad = shot.pad ?? 16;
  const resolve = (spec) => (spec.startsWith('card:')
    ? `[...document.querySelectorAll('.card')].find((c) =>`
      + ` c.querySelector('.card-title')?.textContent.trim() === `
      + `${JSON.stringify(spec.slice('card:'.length))})`
    : `document.querySelector(${JSON.stringify(spec)})`);

  const first = resolve(shot.from);
  const last = resolve(shot.to ?? shot.from);

  return `(() => {
    ${shot.hideChrome ? `document.querySelector('header.topbar')?.remove();` : ''}
    const a = ${first}, b = ${last};
    if (!a || !b) return null;
    a.scrollIntoView({ block: 'start' });
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    // Vertically the frame runs from the TOP of \`a\` to the BOTTOM of \`b\`, and
    // never the union: \`a\` is often an ancestor of \`b\` (the whole detail view,
    // ending at a card partway down it), where a union is the entire page.
    // Horizontally the union is right, since the two can be indented differently.
    const x = Math.max(0, Math.min(ra.left, rb.left) + scrollX - ${pad});
    const y = Math.max(0, ra.top + scrollY - ${pad});
    const right = Math.max(ra.right, rb.right) + scrollX + ${pad};
    const bottom = rb.bottom + scrollY + ${pad};
    return { x, y, width: right - x, height: bottom - y };
  })()`;
}
