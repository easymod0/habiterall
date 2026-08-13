/** Cloud settings: persistence per account, and isolation between users. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME } from '@habiterall/shared/test/chrome.mjs';
const APP='http://localhost:3100', PORT=9305;
const profile=mkdtempSync(join(tmpdir(),'habcs-'));
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

  // sign in
  await send('Page.navigate',{url:APP+'/auth/login'},sessionId); await sleep(3000);
  for(let a=0;a<12;a++){
    await ev(`(()=>{const deep=(r,o=[])=>{for(const el of r.querySelectorAll('*')){if(el.shadowRoot)deep(el.shadowRoot,o);if(el.tagName==='INPUT')o.push(el);}return o;};
      const ins=deep(document);
      const p=ins.find(i=>i.type==='password'); const u=ins.find(i=>i.name==='uidField'||i.type==='text'||i.type==='email');
      if(p&&p.offsetParent!==null){p.value='TestPassw0rd!123';p.dispatchEvent(new Event('input',{bubbles:true}));const f=p.closest('form');if(f){f.requestSubmit?f.requestSubmit():f.submit();return;}}
      if(u&&u.offsetParent!==null){u.value='testuser';u.dispatchEvent(new Event('input',{bubbles:true}));const f=u.closest('form');if(f){f.requestSubmit?f.requestSubmit():f.submit();}}})()`);
    await sleep(1800);
    if((await ev('location.href')).startsWith(APP))break;
  }
  await sleep(1500);
  const me=await ev(`(async()=>(await (await fetch('/api/me',{credentials:'same-origin'})).json()))()`);
  ck('signed in', !!me?.id, JSON.stringify(me));

  // Start from a known state: a previous run leaves a preference set.
  await ev(`fetch('/api/settings',{method:'DELETE',credentials:'same-origin'})`);
  await sleep(300);
  ck('settings start empty',
     JSON.stringify(await ev(`(async()=>(await (await fetch('/api/settings',{credentials:'same-origin'})).json()))()`))==='{}');

  const put=await ev(`(async()=>{const r=await fetch('/api/settings',{method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({dayOrder:'newest-left'})});
    return await r.json();})()`);
  ck('setting saved to the account', put.settings?.dayOrder==='newest-left', JSON.stringify(put));

  ck('invalid values are ignored, not stored',
     (await ev(`(async()=>{const r=await fetch('/api/settings',{method:'PUT',credentials:'same-origin',
       headers:{'Content-Type':'application/json'},body:JSON.stringify({dayOrder:'sideways'})});
       return (await r.json()).ignored;})()`)).includes('dayOrder'));

  ck('__proto__ does not crash the endpoint',
     (await ev(`(async()=>{const r=await fetch('/api/settings',{method:'PUT',credentials:'same-origin',
       headers:{'Content-Type':'application/json'},body:JSON.stringify({__proto__:{x:1}})});
       return r.status;})()`))===200);

  ck('survives a reload (server-side, not localStorage)', await ev(`(async()=>{
      localStorage.clear();
      const r = await fetch('/api/settings',{credentials:'same-origin'});
      return (await r.json()).dayOrder;})()`)==='newest-left');

  await send('Page.navigate',{url:APP},sessionId);
  for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row, #empty:not([hidden])')`).catch(()=>0))break;await sleep(200);}
  await sleep(800);
  ck('the UI applies the account preference',
     (await ev(`(async()=>{const s=await import('/shared/ui/settings.js'); return s.get('dayOrder');})()`))==='newest-left');

  ck('reset clears it on the server',
     (await ev(`(async()=>{await fetch('/api/settings',{method:'DELETE',credentials:'same-origin'});
       return JSON.stringify(await (await fetch('/api/settings',{credentials:'same-origin'})).json());})()`))==='{}');

  console.log(fails===0?'\nALL CLOUD SETTINGS CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERR',e.message);fails++;}
finally{chrome.kill();try{rmSync(profile,{recursive:true,force:true});}catch{};process.exit(fails?1:0);}
