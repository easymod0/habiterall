/**
 * A habit shown as something to avoid, followed from the tap to the row.
 *
 * The rendering is the whole feature, so the thing that can go wrong is the
 * grid and the database disagreeing about what a tap meant. `unknowncheck.mjs`
 * is the model: tap, then ask the API what was actually stored.
 *
 * Two inversions are checked here and neither is visible to a unit test. A tap
 * on an unanswered day records a CLEAN day — value 0 — where the same tap on
 * any other habit records "done"; and a clean day paints as the achievement
 * while a slip paints as the thing to see, which is the opposite of what the
 * at-most branch does for a habit read as an amount.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitForRow,
} from './chrome.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3000', PORT = devtoolsPort(9237);
const profile = mkdtempSync(join(tmpdir(), 'habavoid-'));
const chrome = launchChrome(PORT, profile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};
let ws, nid = 1; const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nid++; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
});

try {
  const url = await devtoolsUrl(PORT, chrome);
  ws = new globalThis.WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
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
  await send('Page.navigate', { url: BASE }, sessionId);
  // The first wait is the only one that legitimately takes any row: nothing of
  // this suite's own exists yet, and what it is waiting for is the dashboard
  // having painted at all.
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('#grid .habit-row')`).catch(() => 0)) break;
    await sleep(250);
  }

  // A habit of the shape the feature is for: stored as a measurable at-most
  // habit with a target of 0, and asked to be SHOWN as something to avoid.
  const made = await ev(`(async()=>{
    const r = await fetch('/api/habits', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name:'Smoking', type:'numerical', unit:'',
        target_value: 0, target_type:'at_most', show_as:'avoid' }) });
    const h = await r.json();
    const d = await (await fetch('/api/overview?days=7')).json();
    return { id: h.id, show_as: h.show_as, end: d.end };})()`);
  console.log(`    habit ${made.id}, show_as=${made.show_as}`);
  check('the server stores the rendering choice', made.show_as === 'avoid', made.show_as);

  await reloadAndWaitForRow(ev, 'Smoking');

  const cell = `(()=>{const rows=[...document.querySelectorAll('#grid .habit-row')];
    const row = rows.find(r => r.textContent.includes('Smoking'));
    // Named, so a regression here reports the missing ROW rather than a
    // TypeError from the property access that follows it.
    if (!row) throw new Error('no dashboard row for "Smoking"');
    return row.querySelector('.day-cell, .check, button[data-focus-key^="check:"]');})()`;

  const stored = async () => ev(`(async()=>{
    const es = await (await fetch('/api/habits/${made.id}/entries')).json();
    const row = es.find(e => e.date === ${JSON.stringify(made.end)});
    return row ? { value: row.value, status: row.status } : null;})()`);

  console.log('\n--- a tap records a CLEAN day, not a done one ---');
  // The inversion, and the reason the encoding lives in ui/toggle.js: the same
  // four states, and only the value each one writes differs. On any other habit
  // this tap would store YES (2).
  await ev(`${cell}.click(); true`);
  await sleep(800);
  let row = await stored();
  check('the first tap stores 0 — "none today"', row?.value === 0, JSON.stringify(row));
  check('and it is not the yes/no sentinel', row?.value !== 2, JSON.stringify(row));

  console.log('\n--- and it paints as the achievement ---');
  const clean = await ev(`(()=>{const c=${cell};
    const s=getComputedStyle(c.querySelector('.check-box') ?? c);
    const box=c.querySelector('.check-box') ?? c;
    return { bg: s.backgroundColor, text: (box.textContent||'').trim() };})()`);
  check('a clean day is filled, not blank',
    clean.bg !== 'rgba(0, 0, 0, 0)' && clean.bg !== 'transparent', JSON.stringify(clean));
  check('and marked with a tick rather than a nought',
    clean.text.includes('✓'), JSON.stringify(clean));

  console.log('\n--- a second tap is the slip, and it looks like one ---');
  await ev(`${cell}.click(); true`);
  await sleep(800);
  row = await stored();
  // The smallest amount that fails a limit of 0. On a limit of 2 it would be 3.
  check('the next tap stores 1 — the smallest amount over', row?.value === 1,
    JSON.stringify(row));

  const slip = await ev(`(()=>{const c=${cell};
    const s=getComputedStyle(c.querySelector('.check-box') ?? c);
    const box=c.querySelector('.check-box') ?? c;
    return { bg: s.backgroundColor, text: (box.textContent||'').trim() };})()`);
  check('a slip is not painted in the habit\'s own colour',
    slip.bg !== clean.bg, `${slip.bg} vs clean ${clean.bg}`);
  check('and is marked as a failure, not a count of one',
    slip.text.includes('✗'), JSON.stringify(slip));

  console.log('\n--- a skip is a skip, not three of the thing ---');
  // The gap that let a real bug through: this suite never turned skips on. The
  // cycle's skip step wrote the SKIP sentinel as a VALUE, and `parseEntry`
  // reads 3 as a skip only for a yes/no habit — so on a measurable one, which
  // is what an avoided habit is underneath, it stored three cigarettes and
  // counted them as a miss. The skip state was unreachable from the grid.
  await ev(`(async()=>{ await fetch('/api/settings', { method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ skipDays: true }) }); })()`);
  await reloadAndWaitForRow(ev, 'Smoking');
  // The day is at `no` when these run, so this is slip -> clean -> skip. The
  // cycle itself is Loop's DONE -> SKIP -> NO, which the rendering does not
  // reorder — stated again at the limit-of-two section below.
  await ev(`${cell}.click(); true`); await sleep(700);
  await ev(`${cell}.click(); true`); await sleep(700);
  row = await stored();
  check('the skip step stores a STATUS', row?.status === 'skip', JSON.stringify(row));
  check('and not the sentinel as an amount', row?.value !== 3, JSON.stringify(row));

  console.log('\n--- a limit of two, where a slip is three ---');
  // The other gap: every check above used a target of 0, where `target + 1` and
  // a bare 1 are the same number and the skip sentinel collides with neither.
  const two = await ev(`(async()=>{
    const r = await fetch('/api/habits', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name:'Coffee', type:'numerical', unit:'cups',
        target_value: 2, target_type:'at_most', show_as:'avoid' }) });
    return (await r.json()).id;})()`);
  await reloadAndWaitForRow(ev, 'Coffee');
  const twoCell = `(()=>{const rows=[...document.querySelectorAll('#grid .habit-row')];
    const row = rows.find(r => r.textContent.includes('Coffee'));
    // Named, for the reason the Smoking cell above is: a regression here
    // reports the missing ROW rather than a TypeError from the property
    // access that follows it. No backticks in here — this is a template
    // literal, and one closes it mid-comment.
    if (!row) throw new Error('no dashboard row for "Coffee"');
    return row.querySelector('.day-cell, .check, button[data-focus-key^="check:"]');})()`;
  const twoStored = async () => ev(`(async()=>{
    const es = await (await fetch('/api/habits/${two}/entries')).json();
    const r = es.find(e => e.date === ${JSON.stringify(made.end)});
    return r ? { value: r.value, status: r.status } : null;})()`);

  await ev(`${twoCell}.click(); true`); await sleep(700);
  check('a clean day on a limit of two is still 0', (await twoStored())?.value === 0,
    JSON.stringify(await twoStored()));
  // With skips enabled the cycle is clean -> skip -> slip, which is Loop's own
  // DONE -> SKIP -> NO. The rendering does not reorder it; only the values move.
  await ev(`${twoCell}.click(); true`); await sleep(700);
  let t = await twoStored();
  check('the skip step is a status even on a limit of two', t?.status === 'skip',
    JSON.stringify(t));
  await ev(`${twoCell}.click(); true`); await sleep(700);
  t = await twoStored();
  check('and a slip is THREE — the smallest amount over', t?.value === 3, JSON.stringify(t));
  check('stored as an amount, not as the skip sentinel', t?.status === '', JSON.stringify(t));
  await ev(`fetch('/api/habits/${two}', { method:'DELETE' })`);
  await ev(`(async()=>{ await fetch('/api/settings', { method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ skipDays: false }) }); })()`);

  console.log('\n--- the same habit read as an amount is unchanged ---');
  // The rendering is a choice and the storage is not: switching it back must
  // leave the rows alone and restore the ordinary controls. Captured rather
  // than hard-coded, since the sections above move this day around.
  const beforeSwitch = await stored();
  await ev(`(async()=>{
    const h = await (await fetch('/api/habits/${made.id}')).json();
    await fetch('/api/habits/${made.id}', { method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ...h, show_as:'amount' }) });})()`);
  await reloadAndWaitForRow(ev, 'Smoking');
  row = await stored();
  // Both non-null, or "unchanged" is two absences agreeing and the check says
  // nothing at all.
  check('there was a row to be left alone', beforeSwitch !== null, JSON.stringify(beforeSwitch));
  check('the stored day is untouched by the switch',
    JSON.stringify(row) === JSON.stringify(beforeSwitch),
    `${JSON.stringify(row)} was ${JSON.stringify(beforeSwitch)}`);

  await ev(`${cell}.click(); true`);
  await sleep(600);
  check('and a tap now asks for an amount instead of cycling',
    await ev(`document.getElementById('count-dialog').open === true`));
  await ev(`document.getElementById('count-cancel').click(); true`);
  await ev(`fetch('/api/habits/${made.id}', { method:'DELETE' })`);
} catch (e) {
  console.log('ERROR:', e.message);
  fails++;
} finally {
  ws?.close();
  await closeChrome({ chrome, port: PORT, profile });
  rmSync(profile, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL AVOID CHECKS PASSED');
process.exit(fails ? 1 : 0);
