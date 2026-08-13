import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from './chrome.mjs';
const BASE = process.env.BASE ?? 'http://localhost:3000', PORT=9230;
const profile=mkdtempSync(join(tmpdir(),'habdrag-'));
const chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,
 `--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(l,c,e='')=>{console.log(`${c?'PASS':'FAIL'}  ${l}${e?' :: '+e:''}`);if(!c)fails++;};
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
  await send('Page.navigate',{url:BASE},sessionId);
  for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(200);}

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
  console.log(fails===0?'\nALL DRAG CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERROR:',e.message);fails++;}
finally{chrome.kill();try{rmSync(profile,{recursive:true,force:true});}catch{};process.exit(fails?1:0);}
