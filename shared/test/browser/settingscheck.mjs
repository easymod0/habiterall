/** Settings dialog: persistence, and that dayOrder actually flips the grid. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';
const APP=process.env.BASE??'http://localhost:3000', PORT=9291;
const profile=mkdtempSync(join(tmpdir(),'habset-'));
const chrome=launchChrome(PORT, profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ck=(l,c,e='')=>{console.log((c?'PASS':'FAIL')+'  '+l+(e?' :: '+e:''));if(!c)fails++;};
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

  console.log('--- nothing is applied until Done ---');
  // The dialog holds a draft. Cancel (and Escape, which <dialog> handles
  // itself) throws it away — before this there was no way to back out, because
  // every control wrote as it was touched.
  const original = await ev(`[...document.querySelectorAll('.grid-date .grid-date-num')].map(e=>e.textContent).join(',')`);
  const pick = (value) => ev(`(()=>{const s=[...document.querySelectorAll('#settings-body select')]
      .find(s=>[...s.options].some(o=>o.value==='${value}'));
    s.value='${value}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);

  await pick('newest-right'); await sleep(400);
  ck('the grid behind the dialog is untouched while editing',
     await ev(`[...document.querySelectorAll('.grid-date .grid-date-num')].map(e=>e.textContent).join(',')`)===original);
  ck('and the server has not been told',
     (await ev(`(async()=>(await (await fetch('/api/settings')).json()))()`)).dayOrder===undefined);

  await ev(`document.getElementById('settings-cancel').click()`); await sleep(400);
  ck('Cancel closes the dialog', await ev(`document.getElementById('settings-dialog').open`)===false);
  ck('Cancel discards the change',
     await ev(`[...document.querySelectorAll('.grid-date .grid-date-num')].map(e=>e.textContent).join(',')`)===original);
  ck('and stores nothing',
     (await ev(`(async()=>(await (await fetch('/api/settings')).json()))()`)).dayOrder===undefined);

  await ev(`document.getElementById('btn-settings').click()`); await sleep(400);
  ck('reopening shows the saved value, not the abandoned draft',
     await ev(`(()=>{const s=[...document.querySelectorAll('#settings-body select')]
       .find(s=>[...s.options].some(o=>o.value==='newest-right'));
       return s.value;})()`)==='newest-left');

  console.log('--- dayOrder flips the grid ---');
  const before = await ev(`[...document.querySelectorAll('.grid-date .grid-date-num')].map(e=>e.textContent).join(',')`);
  await pick('newest-right');
  await ev(`document.getElementById('settings-close').click()`);
  await sleep(700);
  const after = await ev(`[...document.querySelectorAll('.grid-date .grid-date-num')].map(e=>e.textContent).join(',')`);
  ck('grid order reverses', before.split(',').reverse().join(',')===after, `${before} -> ${after}`);
  ck('today moves to the LAST column',
     await ev(`(()=>{const d=[...document.querySelectorAll('.grid-date')];
       return d[d.length-1].classList.contains('is-today');})()`) === true);
  ck('arrows follow the layout (back = left when today is right)',
     await ev(`(()=>{const b=[...document.querySelectorAll('.grid-nav button')]
       .find(b=>b.getAttribute('aria-label')?.startsWith('Previous'));
       return b?.textContent.trim();})()`) === '‹');
  // NOTE: column alignment is covered by gridcheck.mjs, which measures it on
  // a freshly loaded page. Measuring it here proved unreliable — this suite
  // has already registered a service worker, so the document can still be
  // styled by a cached stylesheet and reports a phantom 24px offset.

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
  // Reset is staged like any other edit, so it is undoable until Done.
  await ev(`document.getElementById('settings-reset').click()`); await sleep(400);
  ck('reset alone does not touch the saved values',
     (await ev(`(async()=>(await (await fetch('/api/settings')).json()))()`)).dayOrder==='newest-right');
  await ev(`document.getElementById('settings-close').click()`); await sleep(700);
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

  /* --- "your last reminder was not delivered" --- */
  //
  // A permanent delivery failure used to have exactly one surface: a warn line
  // in the server log. This is the surface that replaced it, and only a real
  // browser can say whether it actually SHOWS — the `hidden`-beaten-by-display
  // class of bug is why this directory exists.
  //
  // Only the transport is faked. Making the server produce a genuine failure
  // would mean pointing it at Discord for real, which no suite here does; the
  // storage half is covered by habiterall-personal/test/notify.integration.mjs.
  console.log('--- a failed delivery is reported in the dialog ---');
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notifyChannels:['android','discord']})}).then(r=>r.ok)`);
  await load();

  await ev(`(()=>{const real=window.fetch;
    window.fetch=(u,o)=>String(u).includes('/api/notify/status')
      ? Promise.resolve(new Response(JSON.stringify({channels:[{
          channel:'discord', ok:false, status:404, permanent:true,
          error:'the webhook was deleted or is no longer accepted — create a new one',
          date:'2026-08-15', mode:'webhook', at:''}]}),
          {headers:{'Content-Type':'application/json'}}))
      : real(u,o);})()`);

  await ev(`document.getElementById('btn-settings').click()`); await sleep(900);
  ck('the failure is shown without being asked for',
     await ev(`!!document.querySelector('.setting-problem')`));
  ck('naming the destination and quoting the sender, not a status code',
     /discord/i.test(await ev(`document.querySelector('.setting-problem')?.textContent??''`)) &&
     /webhook was deleted/i.test(await ev(`document.querySelector('.setting-problem')?.textContent??''`)),
     await ev(`document.querySelector('.setting-problem')?.textContent??''`));
  // The bug this directory exists for: a stylesheet rule can silently defeat an
  // element that is present in the DOM.
  ck('and it is actually visible, not merely present',
     await ev(`(()=>{const p=document.querySelector('.setting-problem');
       if(!p) return false;
       const s=getComputedStyle(p);
       return s.display!=='none' && s.visibility!=='hidden' && p.getBoundingClientRect().height>0;})()`));
  ck('above the controls it is about, not below them',
     await ev(`(()=>{const g=document.querySelector('.setting-problem')?.closest('.data-section');
       if(!g) return false;
       const kids=[...g.children];
       const problem=kids.findIndex(k=>k.classList.contains('setting-problem'));
       const control=kids.findIndex(k=>k.tagName==='LABEL'||k.classList.contains('setting-multi'));
       return problem>=0 && control>=0 && problem<control;})()`));

  // It reads the DRAFT, so switching the destination off clears the warning
  // there and then rather than after a save and a refetch.
  await ev(`(()=>{const b=[...document.querySelectorAll('#settings-body input[type=checkbox]')]
    .find(i=>i.closest('label')?.textContent.toLowerCase().includes('discord'));
    if(b&&b.checked){b.checked=false;b.dispatchEvent(new Event('change',{bubbles:true}));}
    return !!b;})()`);
  await sleep(500);
  ck('switching the destination off clears its warning immediately',
     await ev(`!document.querySelector('.setting-problem')`));

  await ev(`document.getElementById('settings-cancel').click()`); await sleep(300);

  console.log(fails===0?'\nALL SETTINGS CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERR',e.message);fails++;}
finally{await closeChrome({ chrome, port: PORT, profile });process.exit(fails?1:0);}
