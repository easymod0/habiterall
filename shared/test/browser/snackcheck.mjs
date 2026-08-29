import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsPort, devtoolsUrl, launchChrome, reloadAndWaitFor } from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000', PORT = devtoolsPort(9224);
const profile=mkdtempSync(join(tmpdir(),'habsnack-'));
const chrome=launchChrome(PORT, profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(l,c,e='')=>{console.log(`${c?'PASS':'FAIL'}  ${l}${e?' :: '+e:''}`);if(!c)fails++;};
// The cross-check below reads THREE things a reload has to have drawn: the
// calendar cell for this exact day, the History card's bars, and the strip
// cell for this habit and date. "a calendar rect exists" goes true the instant
// the calendar starts drawing and says nothing about either of the other two —
// a poll on that alone is the weak-predicate trap this repo's tests keep
// re-learning, worse than the sleep it used to be paired with.
const detailReady=(day,id)=>`(()=>({
    cal: !!document.querySelector('#view-detail svg[aria-label="Completion calendar"] rect[data-date="${day}"]'),
    hist: !!document.querySelector('#view-detail svg[aria-label="Completion history"] rect'),
    strip: !!document.querySelector('[data-focus-key="check:${id}:${day}"] .check-box'),
  }))()`;
// A derived BOOLEAN over the same three selectors, so there is one source of
// truth for them and no second copy to drift. `detailReady` itself returns an
// object, which is always truthy — handing that straight to `waitUntil` would
// return on the first poll, a worse bug than the one this file is about.
const detailDrawn=(day,id)=>`(d=>d.cal&&d.hist&&d.strip)(${detailReady(day,id)})`;
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
  await send('Page.enable',{},sessionId);await send('Page.navigate',{url:BASE},sessionId);
  for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}

  // open the at_most habit
  const name=await ev(`(async()=>{const d=await (await fetch('/api/overview?days=7')).json();
    const t=d.habits.find(h=>h.target_type==='at_most');
    const i=d.habits.findIndex(h=>h.id===t.id);
    [...document.querySelectorAll('#grid .habit-row')][i].querySelector('.habit-meta').click();
    return t.name+' (at most '+t.target_value+')';})()`);
  console.log('    habit:',name);
  for(let i=0;i<60;i++){if(await ev(`!!document.querySelector('#view-detail svg[aria-label="Completion calendar"] rect')`))break;await sleep(200);}

  const raw=await ev(`(()=>{const o=[];
    for(const r of document.querySelectorAll('#view-detail svg[aria-label="Completion calendar"] rect')){
      const t=r.querySelector('title'); if(!t)continue;
      o.push({date:r.getAttribute('data-date'), title:t.textContent,
              fill:getComputedStyle(r).fill});
    } return o.slice(0,400);})()`);
  console.log('    sample titles:'); raw.filter(r=>!/no entry|future/.test(r.title)).slice(0,6).forEach(r=>console.log('      ',JSON.stringify(r.title),r.fill));
  const cells={};
  // The DAY from `data-date` and the verdict from what follows the first colon.
  // The title used to open with the ISO date and now opens with a written one,
  // so matching a date out of it tied this suite to the runner's locale.
  for(const r of raw){
    if(!r.date)continue;
    const i=String(r.title).indexOf(': '); if(i<0)continue;
    let lab=r.title.slice(i+2).replace(/\s+—\s+click to edit$/,'');
    if(/no entry|future|skipped/.test(lab))continue;
    cells[r.date]={label:lab, fill:r.fill};
  }
  const zero=Object.entries(cells).find(([,v])=>/^0( |$)/.test(v.label));
  const over=Object.entries(cells).find(([,v])=>/^[1-9]/.test(v.label));
  console.log('    zero-day :',JSON.stringify(zero));
  console.log('    over-day :',JSON.stringify(over));
  check('a 0 day exists in the calendar',!!zero);
  check('0 is painted (not the empty grey)',zero&&!/230, 233, 239|35, 40, 48/.test(zero[1].fill),zero?.[1].fill);
  check('0 renders at full colour strength',zero&&/16, 185, 129/.test(zero[1].fill),zero?.[1].fill);
  check('an over-target day renders differently',over&&zero&&over[1].fill!==zero[1].fill,
    `0=${zero?.[1].fill} over=${over?.[1].fill}`);

  /* ---- an unlogged day that already counts as kept (issue #222) ---- */
  console.log('\n--- unlogged-is-success: the calendar, the History bar and the strip agree ---');

  // Day granularity buckets the History card by the exact ISO date
  // (`BUCKETERS.day`), so its bucket and the calendar cell line up one-to-one —
  // the cross-check below needs that, not the week/month roll-up the account
  // otherwise defaults to.
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ historyGranularity: 'day' }) })`);

  // The habit-level override, with the ACCOUNT left at its default `miss`.
  // Mutation 4 is exactly this case: if any surface below reads the account
  // setting instead of the resolved flag, it disagrees with the other two.
  const target=await ev(`(async()=>{
    const habits=await (await fetch('/api/habits')).json();
    const h=habits.find(x=>x.target_type==='at_most');
    await fetch('/api/habits/'+h.id, { method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ...h, at_most_unlogged: 'success' }) });
    const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const d=new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate()-10);
    const bareDay=iso(d);
    // The fixture logs this habit every day; delete the one row so the day is
    // genuinely unanswered rather than a stored 0.
    await fetch('/api/habits/'+h.id+'/entries/'+bareDay, { method:'DELETE' });
    const stats=await (await fetch('/api/habits/'+h.id+'/stats?granularity=day')).json();
    return { id: h.id, bareDay, unlogged_is_success: stats.habit.unlogged_is_success };
  })()`);
  console.log('    override target:',JSON.stringify(target));
  check('the habit override on an account still set to miss resolves true',
    target.unlogged_is_success===true, JSON.stringify(target));

  // `Page.reload` forces the boot cycle to run again and read the server's
  // post-override, post-delete state — and the detail view was ALREADY drawn,
  // with all three of the cal/hist/strip selectors true, before this reload
  // destroys that document. `reloadIntoDetail` is the join: it marks the
  // document, issues the CDP reload, and waits for the marker AND the three
  // selectors together, so nothing below reads a node from the doomed page.
  const reloadIntoDetail=async what=>{
    try{
      await reloadAndWaitFor(ev, detailDrawn(target.bareDay,target.id), {
        reload: () => send('Page.reload',{},sessionId),
        what: `${what}: the calendar cell, History bars and strip cell in the reloaded page`,
      });
    }catch(e){
      const s=await ev(detailReady(target.bareDay,target.id)).catch(()=>null);
      // Three distinct outcomes, and only one of them is "the probe broke":
      // `s === null` really is `ev` throwing (the page navigating out from
      // under it, most likely); an empty `missing` on a non-null `s` means the
      // OPPOSITE — all three are drawn and the timeout still fired, which is
      // the reload never happening (its own CDP error, thrown at :32 before
      // `waitUntil` is ever entered) or the marker surviving the navigation —
      // the one failure mode this whole file exists to catch.
      const detail = s===null ? 'ev threw'
        : (()=>{const missing=['cal','hist','strip'].filter(k=>!s[k]);
            return missing.length ? `still missing: ${missing.join(', ')}`
              : 'all three drawn, so the reload or the marker is what did not happen';})();
      throw new Error(`${e.message} — ${detail}`);
    }
  };
  await reloadIntoDetail('after the habit override');

  const bareCell=await ev(`(()=>{
    const r=document.querySelector(
      '#view-detail svg[aria-label="Completion calendar"] rect[data-date="${target.bareDay}"]');
    if(!r)return null;
    const t=r.querySelector('title');
    return { fill:getComputedStyle(r).fill, title:t?t.textContent:null };
  })()`);
  console.log('    bare-day cell:',JSON.stringify(bareCell));
  check('the bare day is rendered', !!bareCell, JSON.stringify(bareCell));
  check('its label says both facts — counted as kept, AND no entry',
    bareCell&&/counted as kept/.test(bareCell.title)&&/no entry/.test(bareCell.title),
    bareCell?.title);
  check('its fill is a distinguishable partial tint — neither full colour nor empty grey',
    bareCell&&!/16, 185, 129/.test(bareCell.fill)&&
    !/230, 233, 239|35, 40, 48/.test(bareCell.fill), bareCell?.fill);

  // The legend's "Kept, unlogged" swatch has to be the CELL's own colour
  // (`shade`, charts.js — blends toward `--grid-empty`), not `opacity` (blends
  // toward the card behind it). Same "0.07", two different painted colours if
  // the swatch ever goes back to the wrong one — read both through
  // getComputedStyle so the comparison is of what actually painted.
  const legendSwatch=await ev(`(()=>{
    const cards=[...document.querySelectorAll('#view-detail .card')];
    const calCard=cards.find(c=>c.querySelector('.card-title')?.textContent==='Calendar');
    const sw=calCard?.querySelector('.legend .legend-swatch');
    return sw?getComputedStyle(sw).backgroundColor:null;
  })()`);
  console.log('    legend "Kept, unlogged" swatch:',legendSwatch,'vs cell fill:',bareCell?.fill);
  check('the legend swatch paints the same colour as the cell it describes',
    legendSwatch&&bareCell&&legendSwatch===bareCell.fill,
    `swatch=${legendSwatch} cell=${bareCell?.fill}`);

  // The cross-check the whole issue is about: the History card's bucket for
  // the SAME date, found by the date PREFIX the two renderers share
  // (`formatDateShort(fromISOLocal(date))`, read by both `charts.js`'s
  // calendar block and its history bars) — not by parsing either title's
  // second half, which is renderer-specific prose.
  const cross=await ev(`(()=>{
    const calRect=document.querySelector(
      '#view-detail svg[aria-label="Completion calendar"] rect[data-date="${target.bareDay}"]');
    const calTitle=calRect?.querySelector('title')?.textContent||'';
    const prefix=calTitle.split(': ')[0];
    const bars=[...document.querySelectorAll(
      '#view-detail svg[aria-label="Completion history"] title')];
    const match=bars.find(t=>t.textContent.startsWith(prefix+': '));
    return { prefix, matchText: match?match.textContent:null };
  })()`);
  console.log('    history bar match:',JSON.stringify(cross));
  check('the History card has a bucket for the same date as the calendar cell',
    !!cross.matchText, JSON.stringify(cross));
  check('and it agrees the day counted as kept — a full 1/1',
    cross.matchText&&/1\/1/.test(cross.matchText), cross.matchText);

  // The "Recent days" strip: the ghost tick, not the `?`. Only this layer can
  // see it — `paintCheckbox` is module-private and day-strip.js's absolute
  // `/shared/...` specifiers do not resolve under Node.
  const strip=await ev(`(()=>{
    const box=document.querySelector(
      '[data-focus-key="check:${target.id}:${target.bareDay}"] .check-box');
    if(!box)return null;
    return { text: box.textContent, opacity: box.style.opacity, color: box.style.color };
  })()`);
  console.log('    strip cell:',JSON.stringify(strip));
  check('the Recent days strip shows the ghost tick, not a blank or a ?',
    strip&&strip.text==='✓', JSON.stringify(strip));
  check('and it is faint — a ghost, not a real completion',
    strip&&Number(strip.opacity)>0&&Number(strip.opacity)<1, JSON.stringify(strip));

  // The ghost tick must still win with `questionMarks` ON — the one setting
  // that puts a second glyph in contention for the same cell. A version that
  // checks `showUnknown` before `unlogged_is_success` passes every check above
  // (the account default is off) and only shows itself here.
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionMarks: true }) })`);
  await reloadIntoDetail('after questionMarks was turned on');
  const stripQMarks=await ev(`(()=>{
    const box=document.querySelector(
      '[data-focus-key="check:${target.id}:${target.bareDay}"] .check-box');
    if(!box)return null;
    return { text: box.textContent, opacity: box.style.opacity, color: box.style.color };
  })()`);
  console.log('    strip cell with questionMarks on:',JSON.stringify(stripQMarks));
  check('the ghost tick still wins over "?" with question marks on',
    stripQMarks&&stripQMarks.text==='✓', JSON.stringify(stripQMarks));

  // Leave the account as the fixtures left it, or the next suite inherits this.
  await ev(`fetch('/api/settings', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionMarks: false, historyGranularity: 'week' }) })`);

  console.log(fails===0?'\nALL SNACK CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERROR:',e.message);fails++;}
finally{await closeChrome({ chrome, port: PORT, profile });process.exit(fails?1:0);}
