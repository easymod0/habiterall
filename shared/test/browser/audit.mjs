/**
 * Accessibility and layout guard rails.
 *
 * This file spent a long time as a pure diagnostic: every line was a
 * console.log, there was no assertion, no failure counter and no
 * `process.exit`, so the runner reported PASS unconditionally — including
 * with no server running at all. Everything it appeared to verify (the 44px
 * touch-target minimum above all) was in fact unguarded.
 *
 * It now asserts. Keep it that way: a suite that cannot fail is worse than
 * no suite, because it reads as coverage.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000', PORT=9226;
const profile=mkdtempSync(join(tmpdir(),'habaudit-'));
const chrome=launchChrome(PORT, profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;
const check=(label,cond,extra='')=>{
  console.log(`${cond?'PASS':'FAIL'}  ${label}${extra?' :: '+extra:''}`);
  if(!cond)fails++;
};
let ws,nid=1;const pend=new Map();
const send=(m,p={},s)=>new Promise((res,rej)=>{const id=nid++;pend.set(id,{res,rej});
 ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
try{
  const url = await devtoolsUrl(PORT, chrome);
  ws=new globalThis.WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};
  const{targetId}=await send('Target.createTarget',{url:'about:blank'});
  const{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true},sessionId);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;};
  await send('Page.enable',{},sessionId);

  for(const [label,w,h] of [['phone 390x844',390,844],['desktop 1440x900',1440,900]]){
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:w<500},sessionId);
    await send('Page.navigate',{url:BASE},sessionId);
    for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}
    const r=await ev(`(()=>{
      const de=document.documentElement;
      const checks=[...document.querySelectorAll('.check')];
      const sizes=checks.map(c=>{const b=c.getBoundingClientRect();return {w:Math.round(b.width),h:Math.round(b.height)};});
      const small=sizes.filter(s=>s.w<44||s.h<44).length;
      const row=document.querySelector('.habit-row');
      return {
        hScroll: de.scrollWidth>de.clientWidth,
        scrollW: de.scrollWidth, clientW: de.clientWidth,
        checkCount: checks.length,
        checkSize: sizes[0]||null,
        belowTouchMin: small,
        checksOverflow: row? row.querySelector('.checks').scrollWidth > row.querySelector('.checks').clientWidth : null,
        visibleChecks: checks.filter(c=>{const b=c.getBoundingClientRect();return b.left>=0&&b.right<=de.clientWidth;}).length,
      };})()`);
    console.log(`\n--- ${label} ---`);
    check(`${label}: the page does not scroll horizontally`,
      r.hScroll === false, `${r.scrollW} vs ${r.clientW}`);
    check(`${label}: habit rows rendered`, r.checkCount > 0, String(r.checkCount));
    // 44px is the WCAG 2.5.5 / platform minimum for a touch target, and the
    // day cells are the app's primary control on a phone.
    check(`${label}: every day cell meets the 44px touch minimum`,
      r.belowTouchMin === 0,
      `${r.belowTouchMin} of ${r.checkCount} too small, first=${JSON.stringify(r.checkSize)}`);
    check(`${label}: the checks strip does not overflow its row`,
      r.checksOverflow === false, String(r.checksOverflow));
  }

  // a11y + empty state
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false},sessionId);
  await send('Page.navigate',{url:BASE},sessionId);
  for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}
  const a=await ev(`(()=>({
    toastLive: document.getElementById('toast').getAttribute('aria-live'),
    imgsNoAlt: [...document.querySelectorAll('img')].filter(i=>!i.alt).length,
    focusable: document.querySelectorAll('button,a,input,select,[tabindex]').length,
    hasSkipLink: !!document.querySelector('a[href^="#"]'),
    h1: document.querySelectorAll('h1').length,
    contrastDim: getComputedStyle(document.querySelector('.habit-sub')).color,
    docTitle: document.title,
  }))()`);
  console.log('\n--- a11y ---');
  for(const [k,v] of Object.entries(a)) console.log(`  ${k.padEnd(16)}: ${v}`);
  // Toasts announce undo and sync results; without aria-live a screen-reader
  // user never hears them.
  check('the toast region is announced',
    a.toastLive === 'polite' || a.toastLive === 'assertive', String(a.toastLive));
  check('every image has alt text', a.imgsNoAlt === 0, String(a.imgsNoAlt));
  check('exactly one h1', a.h1 === 1, String(a.h1));
  check('the document has a title',
    typeof a.docTitle === 'string' && a.docTitle.length > 0, String(a.docTitle));

  // --- new features ---
  await send('Page.navigate',{url:BASE},sessionId);
  for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}
  const f=await ev(`(()=>({
    toastLive: document.getElementById('toast').getAttribute('aria-live'),
    notesField: !!document.getElementById('day-notes'),
    notesVisible: getComputedStyle(document.getElementById('day-notes-wrap')).display !== 'none',
    archivedCheckbox: !!document.querySelector('#habit-dialog input[name=archived]'),
    archiveToggle: !!document.getElementById('toggle-archived'),
  }))()`);
  console.log('--- new features ---');
  for(const [k,v] of Object.entries(f)) console.log('  '+k.padEnd(18)+': '+v);
  check('the day dialog has a notes field', f.notesField === true);
  check('the habit dialog has an archive control', f.archivedCheckbox === true);
  check('the dashboard has an archive toggle', f.archiveToggle === true);
}catch(e){
  // A thrown harness error is a FAILURE, not a log line. This catch used to
  // swallow everything, which is how the suite passed against a dead server.
  console.error('FAIL  harness error ::', e.message);
  fails++;
}
finally{await closeChrome({ chrome, port: PORT, profile });}

console.log(`
${fails===0?'ALL AUDIT CHECKS PASSED':`${fails} AUDIT CHECK(S) FAILED`}`);
process.exit(fails===0?0:1);
