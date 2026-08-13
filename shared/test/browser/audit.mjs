import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000', PORT=9226;
const profile=mkdtempSync(join(tmpdir(),'habaudit-'));
const chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,
 `--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,nid=1;const pend=new Map();
const send=(m,p={},s)=>new Promise((res,rej)=>{const id=nid++;pend.set(id,{res,rej});
 ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});
try{
  let url;for(let i=0;i<60;i++){try{url=(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;if(url)break;}catch{}await sleep(250);}
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
    console.log('  horizontal page scroll :', r.hScroll, `(${r.scrollW} vs ${r.clientW})`);
    console.log('  check cell size        :', JSON.stringify(r.checkSize), '<- 44px is the a11y min');
    console.log('  cells below 44px       :', r.belowTouchMin, 'of', r.checkCount);
    console.log('  day cells visible      :', r.visibleChecks, 'of 14 per habit row');
    console.log('  checks strip overflows :', r.checksOverflow);
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
}catch(e){console.error('ERROR:',e.message);}
finally{chrome.kill();try{rmSync(profile,{recursive:true,force:true});}catch{}}
