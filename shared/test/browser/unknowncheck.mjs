/**
 * Loop's two tracking settings, end to end in a real browser.
 *
 * What only this layer can prove: that the tap cycle now WRITES a row for a
 * stated "no" instead of deleting one, and that `?` appears on the days with no
 * row when the setting asks for it. Both turn on the difference between
 * `entries[date] === 0` and the key being absent, which a unit test can assert
 * about `nextDayState` but not about what the server ends up holding — the whole
 * bug class here is a cell and a database disagreeing.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';

const APP = process.env.BASE ?? 'http://localhost:3000', PORT = 9296;
const profile = mkdtempSync(join(tmpdir(), 'habunknown-'));
const chrome = launchChrome(PORT, profile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ck = (l, c, e = '') => {
  console.log((c ? 'PASS' : 'FAIL') + '  ' + l + (e ? ' :: ' + e : ''));
  if (!c) fails++;
};
let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++;
  pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  const boot = async () => {
    await send('Page.navigate', { url: APP }, sessionId);
    for (let i = 0; i < 80; i++) {
      if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
      await sleep(250);
    }
    await sleep(600);
  };

  await boot();

  /** A yes/no habit and two clean days on it: today and the day before. */
  const seeded = await ev(`(async () => {
    const habits = await (await fetch('/api/habits')).json();
    const yesno = habits.find(h => h.type === 'boolean' && !h.archived);
    const iso = n => {
      const d = new Date(); d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10);
    };
    const tapDay = iso(1), bareDay = iso(2);
    // Start from nothing on both, so what appears is what the taps did.
    for (const date of [tapDay, bareDay]) {
      await fetch('/api/habits/' + yesno.id + '/entries/' + date, { method: 'DELETE' });
    }
    return { habit: yesno.id, tapDay, bareDay };
  })()`);

  // Reload after seeding. The tap cycle reads the client's own copy of the
  // entries — that is the point of the optimistic paths — so a page holding the
  // fixture's version would start the cycle from a state the server no longer
  // has, which is a fair description of the bug those paths exist to prevent.
  await boot();

  const cell = (date) => `(() => {
    const el = document.querySelector(
      '[data-focus-key="check:${seeded.habit}:${date}"] .check-box');
    return el ? (el.textContent || '').trim() : null;
  })()`;

  const tap = async (date) => {
    await ev(`document.querySelector(
      '[data-focus-key="check:${seeded.habit}:${date}"]')?.click()`);
    await sleep(900);
  };

  const stored = async (date) => await ev(`(async () => {
    const rows = await (await fetch('/api/habits/${seeded.habit}/entries')).json();
    const row = rows.find(e => e.date === '${date}');
    return row ? { value: row.value, status: row.status } : null;
  })()`);

  /* ---------- the default cycle: two taps, and the second is a row ---------- */

  console.log('\n--- default settings (both off) ---');

  ck('an untouched day holds no row at all', (await stored(seeded.tapDay)) === null);

  await tap(seeded.tapDay);
  ck('one tap records done',
    (await stored(seeded.tapDay))?.value === 2, JSON.stringify(await stored(seeded.tapDay)));
  ck('and the cell shows it', (await ev(cell(seeded.tapDay))) === '✓');

  await tap(seeded.tapDay);
  const lapse = await stored(seeded.tapDay);
  // The change this whole feature rests on. This used to be a DELETE, so the
  // stated lapse and the untouched day above were the same absent row and
  // nothing could ever tell them apart.
  ck('the second tap WRITES a lapse rather than deleting the row',
    lapse !== null && lapse.value === 0 && lapse.status === '',
    JSON.stringify(lapse));
  ck('which paints as an empty square while question marks are off',
    (await ev(cell(seeded.tapDay))) === '', String(await ev(cell(seeded.tapDay))));

  // Loop's own behaviour: with question marks off the cycle has two states and
  // never returns to "no data". The day editor is what clears a day.
  await tap(seeded.tapDay);
  ck('a third tap goes back to done, not to no-data',
    (await stored(seeded.tapDay))?.value === 2, JSON.stringify(await stored(seeded.tapDay)));

  /* ---------- question marks ---------- */

  console.log('\n--- questionMarks on ---');

  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionMarks: true }) })`);
  await boot();

  ck('a day with no row paints ?', (await ev(cell(seeded.bareDay))) === '?',
    String(await ev(cell(seeded.bareDay))));
  ck('a day answered "no" does not', (await ev(cell(seeded.tapDay))) !== '?',
    String(await ev(cell(seeded.tapDay))));

  // With the setting on the cycle gains its fourth step, so a tap can clear.
  await tap(seeded.tapDay);                    // done -> no
  ck('done then becomes a lapse', (await stored(seeded.tapDay))?.value === 0,
    JSON.stringify(await stored(seeded.tapDay)));
  await tap(seeded.tapDay);                    // no -> unknown
  ck('and the next tap clears the day entirely',
    (await stored(seeded.tapDay)) === null, JSON.stringify(await stored(seeded.tapDay)));
  ck('so the cell reads ? like any unanswered day',
    (await ev(cell(seeded.tapDay))) === '?', String(await ev(cell(seeded.tapDay))));

  /* ---------- skip days ---------- */

  console.log('\n--- skipDays on ---');

  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipDays: true, questionMarks: false }) })`);
  await boot();

  await tap(seeded.tapDay);                    // unknown -> done
  await tap(seeded.tapDay);                    // done -> skip, only when enabled
  const skipped = await stored(seeded.tapDay);
  ck('the skip step is in the cycle when the setting is on',
    skipped?.status === 'skip' && skipped?.value === 0, JSON.stringify(skipped));
  ck('and it paints as a skip', (await ev(cell(seeded.tapDay))) === '–',
    String(await ev(cell(seeded.tapDay))));

  await tap(seeded.tapDay);                    // skip -> no
  ck('a skip is followed by the lapse, not by a cleared day',
    (await stored(seeded.tapDay))?.value === 0 &&
    (await stored(seeded.tapDay))?.status === '',
    JSON.stringify(await stored(seeded.tapDay)));

  // Leave the account as the fixtures left it, or the next suite inherits this.
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipDays: false, questionMarks: false }) })`);

  console.log(fails === 0 ? '\nALL UNKNOWN/SKIP CHECKS PASSED' : `\n${fails} FAILED`);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await closeChrome({ chrome, port: PORT, profile });
  process.exit(fails ? 1 : 0);
}
