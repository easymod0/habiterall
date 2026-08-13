/**
 * The reminder time picker, in a real browser.
 *
 * Three dropdown/typed controls over one value is exactly the arrangement that
 * looks right in isolation and drifts in practice, so this checks the property
 * that matters: whatever you do to any one of them, the submitted value is the
 * canonical 'HH:MM' the server accepts — and an unparseable box blocks the save
 * instead of silently sending ''.
 *
 * The parsing itself is unit-tested in shared/test/time.test.js; this is about
 * the wiring, the hint text, and the round trip through the form.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, launchChrome } from './chrome.mjs';
const APP=process.env.BASE??'http://localhost:3000', PORT=9298;
const profile=mkdtempSync(join(tmpdir(),'habtime-'));
const chrome=launchChrome(PORT, profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ck=(l,c,e='')=>{console.log((c?'PASS':'FAIL')+'  '+l+(e?' :: '+e:''));if(!c)fails++;};
let ws,nid=1;const pend=new Map();
const send=(m,p={},s)=>new Promise((res,rej)=>{const id=nid++;pend.set(id,{res,rej});
 ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});

const NAME = 'Time picker fixture';

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
  await send('Page.navigate',{url:APP},sessionId); await sleep(1200);
  await ev(`(async()=>{
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  })()`).catch(()=>{});

  const load=async()=>{await send('Page.navigate',{url:APP},sessionId);
    for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}
    await sleep(500);};

  // Typing, as the field sees it: `input` while typing, `change` on leaving.
  const type=async(value,{commit=true}={})=>{
    await ev(`(()=>{const i=document.getElementById('reminder-typed');
      i.value=${JSON.stringify(value)};
      i.dispatchEvent(new Event('input',{bubbles:true}));
      ${commit?`i.dispatchEvent(new Event('change',{bubbles:true}));`:''}})()`);
    await sleep(250);
  };
  const shown=async()=>JSON.parse(await ev(`JSON.stringify({
    typed: document.getElementById('reminder-typed').value,
    hour: document.getElementById('reminder-hour').value,
    minute: document.getElementById('reminder-minute').value,
    hint: document.getElementById('reminder-hint').textContent.trim(),
    error: document.getElementById('reminder-hint').classList.contains('error'),
  })`));

  await load();
  await ev(`document.getElementById('btn-new').click()`); await sleep(400);

  console.log('--- the controls exist and are populated ---');
  ck('the habit dialog opens', await ev(`document.getElementById('habit-dialog').open`)===true);
  ck('24 hours are offered',
     await ev(`document.getElementById('reminder-hour').options.length`)===24);
  ck('minutes step through the hour',
     await ev(`document.getElementById('reminder-minute').options.length`)===12);
  ck('the hour labels give both clocks',
     /13\s+\(1 pm\)/.test(await ev(`document.getElementById('reminder-hour').options[13].textContent`)),
     await ev(`document.getElementById('reminder-hour').options[13].textContent`));
  ck('one-tap common times are offered',
     await ev(`document.querySelectorAll('#reminder-presets button').length`)>=3);
  ck('a new habit starts with no reminder',
     (await shown()).typed==='', JSON.stringify(await shown()));

  console.log('--- typing ---');
  await type('8:30 pm');
  let s = await shown();
  ck('"8:30 pm" is normalised to 20:30', s.typed==='20:30', JSON.stringify(s));
  ck('the dropdowns follow it', s.hour==='20'&&s.minute==='30', JSON.stringify(s));
  ck('and it is read back in both clocks', /8:30 pm/.test(s.hint), s.hint);

  await type('830');
  s = await shown();
  ck('"830" is 08:30', s.typed==='08:30', JSON.stringify(s));

  await type('9');
  s = await shown();
  ck('a bare hour is the top of it', s.typed==='09:00', JSON.stringify(s));

  console.log('--- an odd minute stays selectable ---');
  await type('08:37');
  s = await shown();
  ck('the minute list grows to include 37',
     await ev(`document.getElementById('reminder-minute').options.length`)===13);
  ck('and 37 is what is selected', s.minute==='37', JSON.stringify(s));

  console.log('--- picking from the dropdowns ---');
  await ev(`(()=>{const h=document.getElementById('reminder-hour');
    h.value='06'; h.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(250);
  s = await shown();
  ck('choosing an hour writes the value', s.typed==='06:37', JSON.stringify(s));
  await ev(`(()=>{const m=document.getElementById('reminder-minute');
    m.value='15'; m.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(250);
  s = await shown();
  ck('choosing a minute writes the value', s.typed==='06:15', JSON.stringify(s));

  console.log('--- a preset, and clearing ---');
  await ev(`[...document.querySelectorAll('#reminder-presets button')]
    .find(b=>b.textContent.trim()==='07:00')?.click()`);
  await sleep(250);
  s = await shown();
  ck('a preset sets all three', s.typed==='07:00'&&s.hour==='07'&&s.minute==='00',
     JSON.stringify(s));

  await ev(`document.getElementById('reminder-clear').click()`); await sleep(250);
  s = await shown();
  ck('Clear removes the reminder', s.typed==='', JSON.stringify(s));
  ck('and says so', /no reminder/i.test(s.hint), s.hint);

  console.log('--- nonsense cannot be saved silently ---');
  await ev(`document.querySelector('#habit-form [name=name]').value=${JSON.stringify(NAME)}`);
  await type('lunchtime');
  s = await shown();
  ck('an unparseable time is reported', s.error===true, s.hint);
  ck('and named in the message', /lunchtime/.test(s.hint), s.hint);

  await ev(`document.getElementById('habit-form').requestSubmit()`);
  await sleep(600);
  ck('submitting is refused rather than sending an empty time',
     await ev(`document.getElementById('habit-dialog').open`)===true);
  ck('nothing was created',
     (await ev(`(async()=>(await (await fetch('/api/habits')).json())
        .filter(h=>h.name===${JSON.stringify(NAME)}).length)()`))===0);

  console.log('--- the round trip ---');
  await type('9');
  await ev(`document.querySelector('#habit-form [name=reminder_message]')
    .value='Did you exercise today?'`);
  await ev(`document.getElementById('habit-form').requestSubmit()`);
  await sleep(900);
  ck('a valid time closes the dialog',
     await ev(`document.getElementById('habit-dialog').open`)!==true);

  const saved = JSON.parse(await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    return JSON.stringify(list.find(h=>h.name===${JSON.stringify(NAME)}) ?? null);
  })()`));
  ck('the habit reached the server', !!saved, JSON.stringify(saved));
  ck('with the canonical time, not what was typed',
     saved?.reminder_time==='09:00', saved?.reminder_time);
  ck('and its own prompt',
     saved?.reminder_message==='Did you exercise today?', saved?.reminder_message);

  console.log('--- reopening shows what was stored ---');
  // A full teardown through about:blank, not just a reload: after a modal
  // dialog and a form submit, headless Chromium here can leave the renderer
  // unresponsive to the next evaluate, which reads as a hang with no failure.
  // A new document sidesteps it and costs one navigation.
  await send('Page.navigate',{url:'about:blank'},sessionId); await sleep(400);
  await load();
  await ev(`[...document.querySelectorAll('.habit-row .habit-name, .habit-row .name')]
    .find(e=>e.textContent.trim()===${JSON.stringify(NAME)})?.click()`);
  for(let i=0;i<40;i++){
    if(await ev(`[...document.querySelectorAll('#view-detail button')]
      .some(b=>b.textContent.trim()==='Edit')`).catch(()=>0))break;
    await sleep(200);
  }
  await ev(`[...document.querySelectorAll('#view-detail button')]
    .find(b=>b.textContent.trim()==='Edit')?.click()`);
  await sleep(500);
  s = await shown();
  ck('the picker is loaded from the habit', s.typed==='09:00', JSON.stringify(s));
  ck('including the dropdowns', s.hour==='09'&&s.minute==='00', JSON.stringify(s));
  ck('and the prompt',
     await ev(`document.querySelector('#habit-form [name=reminder_message]').value`)
       ==='Did you exercise today?');

  // Leave the fixture set as it was found.
  await ev(`(async()=>{
    const list = await (await fetch('/api/habits')).json();
    const mine = list.find(h=>h.name===${JSON.stringify(NAME)});
    if (mine) await fetch('/api/habits/'+mine.id,{method:'DELETE'});
  })()`);

  console.log(fails===0?'\nALL TIME PICKER CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERR',e.message);fails++;}
finally{await closeChrome({ chrome, port: PORT, profile });process.exit(fails?1:0);}
