import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from './chrome.mjs';
const APP=process.env.BASE??'http://localhost:3000', PORT=9290;
const profile=mkdtempSync(join(tmpdir(),'habgrid-'));
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
  await send('Page.enable',{},sessionId); await send('Network.enable',{},sessionId);

  for (const [label,w,h] of [['desktop',1440,900],['phone',390,844]]) {
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:w<500},sessionId);
    await send('Page.navigate',{url:APP},sessionId);
    for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}
    await sleep(600);
    console.log(`\n--- ${label} (${w}px) ---`);

    const r = await ev(`(()=>{
      const head=document.getElementById('grid-head');
      const dates=[...document.querySelectorAll('.grid-date')];
      const checks=[...document.querySelectorAll('.habit-row:first-child .check')];
      const cx=el=>{const b=el.getBoundingClientRect();return Math.round(b.left+b.width/2);};
      return {
        headerVisible: head && !head.hidden,
        range: document.querySelector('.grid-range')?.textContent,
        dateCols: dates.length,
        checkCols: checks.length,
        dateCentres: dates.map(cx),
        checkCentres: checks.map(cx),
        todayInHeader: dates.filter(d=>d.classList.contains('is-today')).length,
        todayInRow: document.querySelectorAll('.habit-row:first-child .check.today').length,
        navButtons: [...document.querySelectorAll('.grid-nav button')].map(b=>b.textContent.trim()),
        nextDisabled: [...document.querySelectorAll('.grid-nav button')].find(b=>b.getAttribute('aria-label')?.startsWith('Next'))?.disabled,
      };})()`);

    ck(`${label}: header visible`, r.headerVisible===true);
    ck(`${label}: range label present`, !!r.range, r.range);
    ck(`${label}: one date column per checkbox`, r.dateCols===r.checkCols, `${r.dateCols} vs ${r.checkCols}`);
    const maxOff = Math.max(...r.dateCentres.map((c,i)=>Math.abs(c-r.checkCentres[i])));
    ck(`${label}: columns aligned (max offset ${maxOff}px)`, maxOff<=2, `offsets ok`);
    ck(`${label}: today marked in header`, r.todayInHeader===1, String(r.todayInHeader));
    ck(`${label}: today marked in the row`, r.todayInRow===1, String(r.todayInRow));
    ck(`${label}: next disabled at today`, r.nextDisabled===true, String(r.nextDisabled));
  }

  // --- alignment in the reversed order too ---
  console.log('--- reversed day order ---');
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({dayOrder:'newest-left'})})`);
  await sleep(400);
  await send('Page.navigate',{url:APP},sessionId);
  for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(200);}
  await sleep(600);
  const rev = await ev(`(()=>{const cx=el=>{const b=el.getBoundingClientRect();return b.left+b.width/2;};
    const d=[...document.querySelectorAll('.grid-date')].map(cx);
    const c=[...document.querySelectorAll('.habit-row:first-child .check')].map(cx);
    return {max:Math.round(Math.max(...d.map((v,i)=>Math.abs(v-c[i])))),
            todayFirst:document.querySelector('.grid-date').classList.contains('is-today')};})()`);
  ck('reversed: columns still aligned', rev.max<=2, `${rev.max}px`);
  ck('reversed: today is the first column', rev.todayFirst===true);
  await ev(`fetch('/api/settings',{method:'DELETE',credentials:'same-origin'})`);
  await sleep(300);

  // --- navigation ---
  console.log('\n--- navigation ---');
  const before = await ev(`document.querySelector('.grid-range').textContent`);
  await ev(`[...document.querySelectorAll('.grid-nav button')].find(b=>b.getAttribute('aria-label')?.startsWith('Previous')).click()`);
  await sleep(500);
  const after = await ev(`document.querySelector('.grid-range').textContent`);
  ck('back arrow moves the window', before!==after, `${before} -> ${after}`);
  ck('Today button appears once moved',
     await ev(`[...document.querySelectorAll('.grid-nav button')].some(b=>b.textContent.trim()==='Today')`));
  const noToday = await ev(`document.querySelectorAll('.grid-date.is-today').length`);
  ck('no today marker in a past window', noToday===0, String(noToday));

  await ev(`[...document.querySelectorAll('.grid-nav button')].find(b=>b.textContent.trim()==='Today').click()`);
  await sleep(500);
  ck('Today returns to the current window',
     await ev(`document.querySelector('.grid-range').textContent`)===before);
  ck('cannot navigate past today',
     await ev(`[...document.querySelectorAll('.grid-nav button')].find(b=>b.getAttribute('aria-label')?.startsWith('Next')).disabled`)===true);

  console.log(fails===0?'\nALL GRID CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERR',e.message);fails++;}
finally{chrome.kill();try{rmSync(profile,{recursive:true,force:true});}catch{};process.exit(fails?1:0);}
