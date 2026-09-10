import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor, waitUntil } from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000', PORT = devtoolsPort(9230);
const profile=mkdtempSync(join(tmpdir(),'habdrag-'));
const chrome=launchChrome(PORT, profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(l,c,e='')=>{console.log(`${c?'PASS':'FAIL'}  ${l}${e?' :: '+e:''}`);if(!c)fails++;};
let ws,nid=1;const pend=new Map();
const send=(m,p={},s)=>new Promise((res,rej)=>{const id=nid++;pend.set(id,{res,rej});
 ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
try{
  const url = await devtoolsUrl(PORT, chrome);
  ws=new globalThis.WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};
  const{targetId}=await send('Target.createTarget',{url:'about:blank'});
  const{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true},sessionId);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;};
  await send('Page.enable',{},sessionId);
  await reloadAndWaitFor(ev,`!!document.querySelector('#grid .habit-row')`,
    {reload:()=>send('Page.navigate',{url:BASE},sessionId),what:'the dashboard'});

  const names=()=>ev(`[...document.querySelectorAll('#grid .habit-row .habit-name')].map(n=>n.textContent.trim())`);
  const before=await names();
  console.log('    before:',JSON.stringify(before));

  // simulate a full HTML5 drag of row 0 onto the lower half of row 2
  const moved=await ev(`(()=>{
    const rows=[...document.querySelectorAll('#grid .habit-row')];
    const src=rows[0], dst=rows[2];
    const dt=new DataTransfer();
    src.querySelector('.drag-handle').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
    const b=dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer:dt,clientY:b.top+b.height*0.8}));
    const below=dst.classList.contains('drop-below');
    dst.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt,clientY:b.top+b.height*0.8}));
    src.querySelector('.drag-handle').dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));
    return {below};
  })()`);
  check('drop indicator appears on hover',moved.below===true);
  await sleep(900);
  const after=await names();
  console.log('    after :',JSON.stringify(after));
  // Dropping on the lower half of row 2 places the dragged habit directly
  // after it — not at the end of the list (which only coincided when there
  // were exactly three habits).
  check('dragged habit moved below the drop target',
    after.indexOf(before[0]) === 2,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const persisted=await ev(`(async()=>(await (await fetch('/api/habits')).json()).map(h=>h.name))()`);
  check('drag order persisted',JSON.stringify(persisted)===JSON.stringify(after),JSON.stringify(persisted));
  check('no drag artifacts left behind',
    await ev(`document.querySelectorAll('.dragging,.drop-above,.drop-below').length`)===0);

  // --- keyboard reorder keeps its handle ---
  //
  // HTML5 drag events are unreachable by keyboard, so the arrows are the only
  // way to reorder without a pointer — and they are useless if focus does not
  // follow the habit to its new row. persistOrder used to re-focus the handle
  // by hand; paint() now restores it by data-focus-key, which names the habit
  // rather than the position, so this is the check that the general mechanism
  // really replaced the special case.
  console.log('\n--- keyboard reorder ---');
  const firstName = (await names())[0];
  const handleKey = await ev(`(()=>{
    const h=document.querySelector('.habit-row:first-child .drag-handle');
    h.focus(); return h.dataset.focusKey;
  })()`);
  await ev(`document.activeElement.dispatchEvent(
    new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
  await sleep(900);
  const nudged=await names();
  check('arrow down moves the habit one slot',
    nudged.indexOf(firstName)===1, `${firstName}: ${JSON.stringify(nudged)}`);
  check('focus follows the handle to its new row',
    await ev(`document.activeElement?.dataset?.focusKey ?? null`)===handleKey,
    `${handleKey} -> ${await ev(`document.activeElement?.dataset?.focusKey ?? document.activeElement?.tagName`)}`);
  check('and it is the moved habit\'s own handle',
    await ev(`document.activeElement?.closest('.habit-row')
      ?.querySelector('.habit-name')?.textContent?.trim()`)===firstName);

  // --- habitSort (#200) gates the drag handle, the fifth clause ---
  //
  // Through the REAL settings dialog, not a raw `PUT /settings`: the sort is
  // decided server-side, so the browser only sees the new order once
  // `applyDraft` decides to refetch it (`SERVER_COMPUTED`, `ui/settings-dialog.js`),
  // and that decision is exactly what this block is checking. A bare fetch
  // would update the stored setting and leave the on-screen order and the
  // gate both stale until something else repainted, which would make this
  // pass for reasons that have nothing to do with the wiring under test.
  console.log('\n--- habitSort gates the drag handle ---');

  const handleCount = () => ev(`document.querySelectorAll('.drag-handle').length`);
  const openSettings = async () => {
    await ev(`document.getElementById('btn-settings').click(); true`);
    await waitUntil(ev, `document.getElementById('settings-dialog').open === true`,
      { what: 'the settings dialog to open' });
  };
  const pickHabitSort = (value) => ev(`(() => {
    const s = document.getElementById('setting-habitSort');
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const pressDone = () => ev(`document.getElementById('settings-close').click(); true`);

  const manualOrder = await names();
  check('under the default (no habitSort stored) the drag handle is present',
    await handleCount() === manualOrder.length, String(await handleCount()));

  await openSettings();
  await pickHabitSort('name');
  await pressDone();

  // Named order, not "some row exists" — waitUntil on a weak predicate would
  // return the instant the (unchanged) grid repaints for any other reason.
  const nameOrder = [...manualOrder].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-name')]
      .map(n=>n.textContent.trim()).join('|') === ${JSON.stringify(nameOrder.join('|'))}`,
    { what: 'the dashboard to redraw in name order' });

  check('the list order actually changed under the sort',
    JSON.stringify(await names()) !== JSON.stringify(manualOrder),
    `${JSON.stringify(manualOrder)} -> ${JSON.stringify(await names())}`);
  check('the drag handle is gone once a sort other than manual is stored',
    await handleCount() === 0, String(await handleCount()));

  await openSettings();
  await pickHabitSort('manual');
  await pressDone();

  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-name')]
      .map(n=>n.textContent.trim()).join('|') === ${JSON.stringify(manualOrder.join('|'))}`,
    { what: 'the dashboard to redraw back in manual (position) order' });

  check('the drag handle is back once the sort is set back to manual',
    await handleCount() === manualOrder.length, String(await handleCount()));

  // --- issue #200 review: the TWO-TAB regression, the reason the gate moved ---
  //
  // The dialog-driven block above proves the ordinary path and
  // `SERVER_COMPUTED`'s refetch, and it cannot prove the fix: going through
  // the dialog changes the settings CACHE and the habit ORDER together, on
  // the same press, so a gate reading either one passes it. This is tab B
  // from the issue instead — the setting changes on the SERVER without this
  // page's settings dialog ever touching it (`settings.init()` runs once per
  // boot and nothing re-reads `/api/settings` afterwards) — a direct
  // `PUT /api/settings`, then the `emit('reload')` a reconnect or another
  // save already drives `load()` with.
  console.log('\n--- habitSort: two tabs, one stale settings cache ---');

  const twoTabBefore = await names();
  const twoTabNameOrder = [...twoTabBefore].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));

  const twoTabPut = await ev(`(async () => {
    const r = await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ habitSort: 'name' }),
    });
    if (!r.ok) return { status: r.status };
    (await import('/shared/ui/store.js')).emit('reload');
    return { status: r.status };
  })()`);
  check('the direct PUT /api/settings (not the dialog) was accepted',
    twoTabPut.status === 200, JSON.stringify(twoTabPut));

  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-name')]
      .map(n=>n.textContent.trim()).join('|') === ${JSON.stringify(twoTabNameOrder.join('|'))}`,
    { what: "tab B's own load() to reach name order" });

  check('the list came back in the new order',
    JSON.stringify(await names()) === JSON.stringify(twoTabNameOrder),
    JSON.stringify(await names()));
  check('the drag handle is gone, even though this page\'s dialog never ran',
    await handleCount() === 0, String(await handleCount()));

  // The assertion that actually distinguishes "the gate reads the payload"
  // from "the settings cache happened to update anyway": this page's
  // settings cache was never touched by the write above (no dialog, no
  // `settings.save`), so it must still answer the OLD value at the exact
  // moment the handle is gone. Without this half, mutating `canReorder` back
  // to `settings.get('habitSort')` would still pass every check above it —
  // the cache and the payload agree everywhere except this one window.
  const staleCacheValue = await ev(
    `(async () => (await import('/shared/ui/settings.js')).get('habitSort'))()`);
  check("settings.get('habitSort') on this page still answers 'manual'",
    staleCacheValue === 'manual', String(staleCacheValue));

  await ev(`(async () => {
    const r = await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ habitSort: 'manual' }),
    });
    (await import('/shared/ui/store.js')).emit('reload');
    return r.status;
  })()`);
  await waitUntil(ev,
    `[...document.querySelectorAll('#grid .habit-name')]
      .map(n=>n.textContent.trim()).join('|') === ${JSON.stringify(manualOrder.join('|'))}`,
    { what: 'the dashboard to settle back in manual order after the two-tab check' });

  console.log(fails===0?'\nALL DRAG CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERROR:',e.message);fails++;}
finally{await closeChrome({ chrome, port: PORT, profile });process.exit(fails?1:0);}
