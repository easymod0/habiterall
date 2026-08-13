import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000', PORT=9224;
const profile=mkdtempSync(join(tmpdir(),'habsnack-'));
const chrome=launchChrome(PORT, profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(l,c,e='')=>{console.log(`${c?'PASS':'FAIL'}  ${l}${e?' :: '+e:''}`);if(!c)fails++;};
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
      o.push({title:t.textContent, fill:getComputedStyle(r).fill});
    } return o.slice(0,400);})()`);
  console.log('    sample titles:'); raw.filter(r=>!/no entry|future/.test(r.title)).slice(0,6).forEach(r=>console.log('      ',JSON.stringify(r.title),r.fill));
  const cells={};
  for(const r of raw){
    const m=r.title.match(/^(\d{4}-\d{2}-\d{2}):\s*(.*)$/); if(!m)continue;
    let lab=m[2].replace(/\s+—\s+click to edit$/,'');
    if(/no entry|future|skipped/.test(lab))continue;
    cells[m[1]]={label:lab, fill:r.fill};
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
  console.log(fails===0?'\nALL SNACK CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERROR:',e.message);fails++;}
finally{await closeChrome({ chrome, port: PORT, profile });process.exit(fails?1:0);}
