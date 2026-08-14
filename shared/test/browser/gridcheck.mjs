import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';
const APP=process.env.BASE??'http://localhost:3000', PORT=9290;
const profile=mkdtempSync(join(tmpdir(),'habgrid-'));
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

  // --- arrows must not move when Today appears ---
  console.log('--- arrow stability ---');
  const arrowX = () => ev(`(()=>{
    const b=[...document.querySelectorAll('.grid-nav button')]
      .find(b=>b.getAttribute('aria-label')?.startsWith('Previous'));
    return b ? Math.round(b.getBoundingClientRect().left) : null;})()`);
  const beforeX = await arrowX();
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b=>b.getAttribute('aria-label')?.startsWith('Previous')).click()`);
  await sleep(900);
  const afterX = await arrowX();
  ck('the back arrow stays put when Today appears', beforeX === afterX,
     `${beforeX}px -> ${afterX}px`);
  ck('Today is now clickable',
     await ev(`(()=>{const b=[...document.querySelectorAll('.grid-nav button')]
       .find(b=>b.textContent.trim()==='Today');
       return !!b && !b.disabled && getComputedStyle(b).visibility==='visible';})()`) === true);
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b=>b.textContent.trim()==='Today').click()`);
  await sleep(900);
  ck('and the arrow is still in the same place after returning',
     await arrowX() === beforeX, `${await arrowX()}px`);

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

  // --- keyboard focus survives a repaint ---
  //
  // Every one of these rebuilds the grid with replaceChildren(), which
  // destroys the focused element. Before paint() restored focus by
  // data-focus-key, tabbing to a checkbox and pressing Enter dropped focus to
  // <body> and the next Tab started from the top of the document.
  console.log('\n--- keyboard focus ---');

  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b=>b.getAttribute('aria-label')?.startsWith('Previous')).focus()`);
  await ev(`document.activeElement.click()`);
  await sleep(700);
  ck('focus stays on the paging arrow',
     await ev(`document.activeElement?.dataset?.focusKey`)==='nav:older',
     await ev(`document.activeElement?.dataset?.focusKey ?? document.activeElement?.tagName`));

  // Today disables itself once it has nowhere to jump to, and .focus() on a
  // disabled button is a no-op — so this is the case that needs the fallback
  // to a working neighbour rather than a plain restore.
  await ev(`[...document.querySelectorAll('.grid-nav button')]
    .find(b=>b.textContent.trim()==='Today').focus()`);
  await ev(`document.activeElement.click()`);
  await sleep(700);
  const afterToday = await ev(`({key:document.activeElement?.dataset?.focusKey??null,
                                 tag:document.activeElement?.tagName})`);
  ck('Today hands focus to a working neighbour rather than dropping it',
     afterToday.key!==null && afterToday.tag!=='BODY', JSON.stringify(afterToday));

  // A check-off repaints twice — optimistically, then again after the refetch
  // that brings the new score and streak. Both have to keep focus.
  // `prompt` is stubbed so this works whichever habit type sits in row one; a
  // measurable habit would otherwise block headless Chrome on the dialog.
  await ev(`window.prompt = () => '1'; true`);
  const checkKey = await ev(`(()=>{
    const c=document.querySelector('.habit-row:first-child .check');
    c.focus(); return c.dataset.focusKey;
  })()`);
  ck('checkboxes carry a focus key', !!checkKey, String(checkKey));
  await ev(`document.activeElement.click()`);
  await sleep(1200);
  const afterCheck = await ev(`document.activeElement?.dataset?.focusKey ?? null`);
  ck('focus stays on the checkbox across a check-off',
     afterCheck===checkKey, `${checkKey} -> ${afterCheck}`);

  // --- 3 is an amount for a measurable habit, and a skip only for a yes/no one
  //
  // /overview flattens a skip onto the SKIP wire value so the grid has
  // something paintable, AND lists the date in `skips`. Painting from the
  // value alone made "3 pages" and "3 cigarettes" render as skipped days while
  // the score behind them counted the 3 — the cell disagreeing with every
  // figure computed from it. Only a browser sees what was painted.
  const seeded = await ev(`(async () => {
    const habits = await (await fetch('/api/habits')).json();
    const read = habits.find(h => h.type === 'numerical');
    const yesno = habits.find(h => h.type === 'boolean');
    const d = (n) => {
      const x = new Date(); x.setHours(12,0,0,0); x.setDate(x.getDate() - n);
      return x.getFullYear() + '-' +
             String(x.getMonth()+1).padStart(2,'0') + '-' +
             String(x.getDate()).padStart(2,'0');
    };
    const put = (id, date, body) => fetch('/api/habits/' + id + '/entries/' + date, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await put(read.id, d(1), { value: 3 });         // three pages, genuinely
    await put(read.id, d(2), { status: 'skip' });   // an actual skipped day
    await put(yesno.id, d(3), { status: 'skip' });  // one to clear, offline, below
    return { read: read.id, yesno: yesno.id, amount: d(1), skip: d(2), clearMe: d(3) };
  })()`);

  await send('Page.navigate',{url:APP},sessionId);
  for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}
  await sleep(600);

  const painted = await ev(`(() => {
    const s = ${JSON.stringify(seeded)};
    const box = (habit, date) => {
      const el = document.querySelector('[data-focus-key="check:' + habit + ':' + date + '"] .check-box');
      return el ? (el.textContent || '').trim() : null;
    };
    return { amount: box(s.read, s.amount), skip: box(s.read, s.skip),
             toClear: box(s.yesno, s.clearMe) };
  })()`);

  ck('a measurable 3 paints as the amount, not as a skip',
     painted.amount === '3', JSON.stringify(painted));
  ck('a real skip still paints as one', painted.skip === '–', JSON.stringify(painted));
  ck('a skipped yes/no day paints as one too', painted.toClear === '–',
     JSON.stringify(painted));

  // --- clearing a skip repaints the cell, with no server to ask
  //
  // The optimistic paths edit `habit.entries`; the cell is painted from
  // `habit.skips`. Edit one without the other and the cell keeps asserting the
  // old state until a refetch corrects it — which offline never happens, since
  // `api()` queues the write and throws. Emulating offline is what makes this
  // deterministic: online the refetch hides the bug behind a repaint.
  await send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);

  await ev(`document.querySelector(
    '[data-focus-key="check:${seeded.yesno}:${seeded.clearMe}"]')?.click()`);
  await sleep(1200);

  const cleared = await ev(`(() => {
    const el = document.querySelector('[data-focus-key="check:${seeded.yesno}:${seeded.clearMe}"] .check-box');
    return el ? (el.textContent || '').trim() : null;
  })()`);
  ck('clearing a skip while offline repaints the cell', cleared === '',
     `cell reads "${cleared}" after the tap`);

  await send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);

  console.log(fails===0?'\nALL GRID CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERR',e.message);fails++;}
finally{await closeChrome({ chrome, port: PORT, profile });process.exit(fails?1:0);}
