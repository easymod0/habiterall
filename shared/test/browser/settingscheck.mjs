/** Settings dialog: persistence, and that dayOrder actually flips the grid. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from './chrome.mjs';
const APP=process.env.BASE??'http://localhost:3000', PORT=9291;
const profile=mkdtempSync(join(tmpdir(),'habset-'));
const chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,
 `--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ck=(l,c,e='')=>{console.log((c?'PASS':'FAIL')+'  '+l+(e?' :: '+e:''));if(!c)fails++;};
let ws,nid=1;const pend=new Map();
const send=(m,p={},s)=>new Promise((res,rej)=>{const id=nid++;pend.set(id,{res,rej});
 ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
try{
  let url;for(let i=0;i<60;i++){try{url=(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;if(url)break;}catch{}await sleep(250);}
  ws=new globalThis.WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};
  const{targetId}=await send('Target.createTarget',{url:'about:blank'});
  const{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true},sessionId);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;};
  await send('Page.enable',{},sessionId);
  await send('Network.enable',{},sessionId);
  await send('Network.setCacheDisabled',{cacheDisabled:true},sessionId);
  // A registered service worker would serve a cached stylesheet, so this
  // suite measured stale CSS and reported phantom misalignment. Clear it.
  await send('Page.navigate',{url:APP},sessionId); await sleep(1200);
  await ev(`(async()=>{
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  })()`).catch(()=>{});
  // Reload AFTER unregistering: the first load was already styled by the
  // worker, so measuring now would report the stale stylesheet.
  await send('Page.navigate',{url:APP},sessionId); await sleep(1500);

  const load=async()=>{await send('Page.navigate',{url:APP},sessionId);
    for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}
    await sleep(500);};
  await load();

  console.log('--- dialog ---');
  await ev(`document.getElementById('btn-settings').click()`); await sleep(400);
  ck('settings dialog opens', await ev(`document.getElementById('settings-dialog').open`));
  ck('controls rendered from the registry',
     await ev(`document.querySelectorAll('#settings-body select, #settings-body input').length`) >= 2);
  const sections = await ev(`[...document.querySelectorAll('#settings-body h3')].map(h=>h.textContent).join(',')`);
  ck('sections rendered', sections.includes('Dashboard'), sections);

  console.log('--- dayOrder flips the grid ---');
  const before = await ev(`[...document.querySelectorAll('.grid-date .grid-date-num')].map(e=>e.textContent).join(',')`);
  await ev(`(()=>{const s=[...document.querySelectorAll('#settings-body select')]
      .find(s=>[...s.options].some(o=>o.value==='newest-right'));
    s.value='newest-right'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(600);
  const after = await ev(`[...document.querySelectorAll('.grid-date .grid-date-num')].map(e=>e.textContent).join(',')`);
  ck('grid order reverses', before.split(',').reverse().join(',')===after, `${before} -> ${after}`);
  ck('today moves to the LAST column',
     await ev(`(()=>{const d=[...document.querySelectorAll('.grid-date')];
       return d[d.length-1].classList.contains('is-today');})()`) === true);
  ck('arrows follow the layout (back = left when today is right)',
     await ev(`(()=>{const b=[...document.querySelectorAll('.grid-nav button')]
       .find(b=>b.getAttribute('aria-label')?.startsWith('Previous'));
       return b?.textContent.trim();})()`) === '‹');
  await sleep(300);
  // NOTE: column alignment is covered by gridcheck.mjs, which measures it on
  // a freshly loaded page. Measuring it here proved unreliable — this suite
  // has already registered a service worker, so the document can still be
  // styled by a cached stylesheet and reports a phantom 24px offset.
  await ev(`document.getElementById('settings-close').click()`);
  await sleep(300);

  console.log('--- persistence ---');
  await load();
  ck('preference survives a reload',
     await ev(`(()=>{const d=[...document.querySelectorAll('.grid-date')];
       return d[d.length-1].classList.contains('is-today');})()`) === true);
  ck('cached in localStorage for a fast first paint',
     JSON.parse(await ev(`localStorage.getItem('habiterall-settings')`)).dayOrder === 'newest-right');
  ck('persisted on the SERVER, not just the device',
     (await ev(`(async()=>(await (await fetch('/api/settings')).json()))()`)).dayOrder === 'newest-right');

  console.log('--- reset ---');
  await ev(`document.getElementById('btn-settings').click()`); await sleep(300);
  await ev(`document.getElementById('settings-reset').click()`); await sleep(600);
  ck('reset restores the default (today on the left)',
     await ev(`document.querySelector('.grid-date').classList.contains('is-today')`) === true);

  console.log('--- invalid values are ignored ---');
  await ev(`localStorage.setItem('habiterall-settings', JSON.stringify({dayOrder:'sideways'}))`);
  await load();
  // Assert the fallback actually HAPPENED, not merely that the grid drew
  // something. This used to check `.grid-date.length > 0`, which would pass
  // just as happily if the bogus value had been honoured — as long as any
  // columns appeared at all.
  ck('a bogus stored value falls back to the default (today on the left)',
     await ev(`document.querySelector('.grid-date')?.classList.contains('is-today')`) === true,
     await ev(`JSON.stringify([...document.querySelectorAll('.grid-date')].slice(0,3).map(d=>d.textContent.trim()))`));
  await ev(`localStorage.setItem('habiterall-settings','not json')`);
  await load();
  ck('corrupt storage does not break the app',
     await ev(`!!document.querySelector('#grid .habit-row')`) === true);

  /* --- the dialog must override a session toggle --- */
  //
  // Settings with an in-place control keep a session override in `state`, so
  // trying a value does not rewrite the saved default. The catch is that the
  // override then SHADOWS the dialog: without `applySetting` clearing it,
  // choosing a value in Settings appears to do nothing once you have touched
  // the toggle. The trap is documented in shared/CLAUDE.md and was untested.
  console.log('--- the dialog beats an in-place toggle ---');
  await ev(`localStorage.removeItem('habiterall-settings')`);
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({calendarZoom:'default'})}).then(r=>r.ok)`);
  await load();

  // Open a habit and zoom in — this sets the session override.
  await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('[aria-label="Completion calendar"]')`).catch(()=>0)) break;
    await sleep(200);
  }
  await sleep(400);
  const cellOf = () => ev(`(()=>{const c=document.querySelector('rect.cal-cell[data-date]');
    return c ? Math.round(c.getBoundingClientRect().width) : 0;})()`);

  const atDefault = await cellOf();
  await ev(`[...document.querySelectorAll('.cal-nav button')].find(b=>b.textContent.trim()==='+')?.click()`);
  await sleep(600);
  const afterToggle = await cellOf();
  ck('the in-place toggle changes the zoom', afterToggle > atDefault,
     `${atDefault}px -> ${afterToggle}px`);

  // Now choose the ORIGINAL value in the dialog. It must win.
  await ev(`document.getElementById('btn-settings').click()`);
  await sleep(400);
  await ev(`(()=>{const s=[...document.querySelectorAll('#settings-body select')]
    .find(x=>[...x.options].some(o=>o.value==='closest'));
    if(!s) return false;
    s.value='default'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
  await sleep(700);
  await ev(`document.getElementById('settings-close')?.click()`);
  await sleep(500);

  // Closing the dialog returns to the dashboard, so reopen the habit before
  // measuring — otherwise this reads 0 and looks like a failure of the thing
  // being tested rather than of the navigation.
  await ev(`document.querySelector('.habit-row .habit-name, .habit-row .name')?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('rect.cal-cell[data-date]')`).catch(()=>0)) break;
    await sleep(200);
  }
  await sleep(400);
  const afterDialog = await cellOf();
  ck('choosing in the dialog overrides the toggle', afterDialog === atDefault,
     `expected ${atDefault}px, got ${afterDialog}px`);

  console.log(fails===0?'\nALL SETTINGS CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERR',e.message);fails++;}
finally{chrome.kill();try{rmSync(profile,{recursive:true,force:true});}catch{};process.exit(fails?1:0);}
