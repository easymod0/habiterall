/**
 * Notification settings in a real browser.
 *
 * Three things here cannot be checked anywhere else: that a dependent control
 * (the webhook URL) appears only once its destination is switched on, that a
 * rejected value snaps back instead of appearing to have been saved, and that
 * a multi-value setting round-trips to the server as a list rather than as the
 * last checkbox that happened to be clicked.
 *
 * It never posts to Discord: the test button is only checked for its presence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeChrome, devtoolsUrl, launchChrome } from './chrome.mjs';
const APP=process.env.BASE??'http://localhost:3000', PORT=9297;
const profile=mkdtempSync(join(tmpdir(),'habnotify-'));
const chrome=launchChrome(PORT, profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ck=(l,c,e='')=>{console.log((c?'PASS':'FAIL')+'  '+l+(e?' :: '+e:''));if(!c)fails++;};
let ws,nid=1;const pend=new Map();
const send=(m,p={},s)=>new Promise((res,rej)=>{const id=nid++;pend.set(id,{res,rej});
 ws.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});

const WEBHOOK='https://discord.com/api/webhooks/123456789012345678/browser-test-token';

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
  await send('Page.navigate',{url:APP},sessionId); await sleep(1200);
  await ev(`(async()=>{
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  })()`).catch(()=>{});

  const load=async()=>{await send('Page.navigate',{url:APP},sessionId);
    for(let i=0;i<80;i++){if(await ev(`!!document.querySelector('#grid .habit-row')`).catch(()=>0))break;await sleep(250);}
    await sleep(500);};
  const open=async()=>{await ev(`document.getElementById('btn-settings').click()`);await sleep(400);};
  // Nothing the dialog does reaches the server until Done. On a value the
  // server refuses, Done leaves the dialog OPEN with the field showing what is
  // actually stored, so several sections below carry on without reopening.
  const done=async()=>{await ev(`document.getElementById('settings-close').click()`);await sleep(800);};
  // Named, not counted: there are several text fields under Notifications now,
  // and an index would quietly retarget the moment one is added above.
  const webhookField=`document.getElementById('setting-discordWebhook')`;
  const channelField=`document.getElementById('setting-discordChannelId')`;
  const channelBox=id=>`document.getElementById('setting-notifyChannels-${id}')`;
  const serverSettings=async()=>JSON.parse(await ev(
    `(async()=>JSON.stringify(await (await fetch('/api/settings')).json()))()`));

  await ev(`localStorage.removeItem('habiterall-settings')`);
  await ev(`fetch('/api/settings',{method:'DELETE',credentials:'same-origin'}).then(r=>r.ok)`);
  await load();
  await open();

  console.log('--- the section renders from the registry ---');
  const sections=await ev(`[...document.querySelectorAll('#settings-body h3')].map(h=>h.textContent).join(',')`);
  ck('a Notifications section exists', sections.includes('Notifications'), sections);
  ck('both destinations are offered',
     await ev(`document.querySelectorAll('.setting-multi input[type=checkbox]').length`)===2);
  ck('the on-device destination is on by default',
     await ev(`${channelBox('android')}.checked`)===true);
  ck('and Discord is not', await ev(`${channelBox('discord')}.checked`)===false);
  ck('a test button is offered',
     await ev(`[...document.querySelectorAll('#settings-body button')]
       .some(b=>/test notification/i.test(b.textContent))`)===true);

  console.log('--- the Discord fields wait until they are relevant ---');
  ck('no webhook field while Discord is off', await ev(`!${webhookField}`)===true);
  ck('no channel field either', await ev(`!${channelField}`)===true);
  await ev(`${channelBox('discord')}.click()`); await sleep(500);
  ck('checking Discord reveals the webhook field', await ev(`!!${webhookField}`)===true);
  ck('and the channel id field, for the interactive mode',
     await ev(`!!${channelField}`)===true);
  // The user id only narrows who may press the buttons, so it is noise until
  // there is a channel for those buttons to appear in.
  ck('but not the user id field, which has nothing to narrow yet',
     await ev(`!document.getElementById('setting-discordUserId')`)===true);
  // By its id, like the two checks above, rather than by matching an option's
  // COPY: this is about whether the control is shown, and pinning its wording
  // made rewording one option look like the control had disappeared.
  ck('and the timezone control, which only servers need',
     await ev(`!!document.getElementById('setting-notifyTimezone')`)===true);
  // Its default is "follow this device", which is what an account that never
  // opens this dialog gets — so it is the one option that must always exist.
  ck('offering to follow this device, which is the default',
     await ev(`[...(document.getElementById('setting-notifyTimezone')?.options ?? [])]
       .some(o=>o.value==='auto')`)===true);
  // The dependent fields follow the DRAFT, so they appear the moment the box
  // is ticked — but the tick itself is not a write.
  ck('ticking a destination changes nothing on the server yet',
     (await serverSettings()).notifyChannels===undefined,
     JSON.stringify((await serverSettings()).notifyChannels));
  await done(); await open();
  ck('the choice reaches the server once Done is pressed',
     JSON.stringify((await serverSettings()).notifyChannels)==='["android","discord"]',
     JSON.stringify((await serverSettings()).notifyChannels));

  console.log('--- a rejected URL does not pretend to be saved ---');
  await ev(`(()=>{const i=${webhookField};
    i.value='https://169.254.169.254/api/webhooks/1/a';
    i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await done();
  ck('the dialog stays open on a value the server refused',
     await ev(`document.getElementById('settings-dialog').open`)===true);
  ck('the field snaps back to what is stored',
     await ev(`${webhookField}.value`)==='', await ev(`${webhookField}.value`));
  ck('and nothing was stored', (await serverSettings()).discordWebhook===undefined);
  ck('the user is told, rather than left thinking it saved',
     await ev(`(()=>{const t=document.getElementById('toast');
       return !t.hidden && /webhook/i.test(t.textContent) ? t.textContent : '';})()`)!=='' ,
     await ev(`document.getElementById('toast').textContent`));

  console.log('--- a real webhook is stored and canonicalised ---');
  await ev(`(()=>{const i=${webhookField};
    i.value='${WEBHOOK}?wait=true';
    i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await done();
  ck('an accepted value closes the dialog',
     await ev(`document.getElementById('settings-dialog').open`)===false);
  ck('stored on the server', (await serverSettings()).discordWebhook===WEBHOOK);
  await open();
  ck('the query string is dropped in the field too',
     await ev(`${webhookField}.value`)===WEBHOOK, await ev(`${webhookField}.value`));
  await ev(`document.getElementById('settings-cancel').click()`); await sleep(300);

  console.log('--- it survives a reload ---');
  await load(); await open();
  ck('Discord is still checked', await ev(`${channelBox('discord')}.checked`)===true);
  ck('the webhook is still shown', await ev(`${webhookField}.value`)===WEBHOOK);

  console.log('--- a channel id unlocks the "only my clicks" field ---');
  await ev(`(()=>{const i=${channelField};
    i.value='123456789012345678';
    i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(400);
  // Straight off the draft: the field it gates appears before anything is
  // written, which is what makes the dialog usable while it holds one.
  ck('the user id field appears without waiting for Done',
     await ev(`!!document.getElementById('setting-discordUserId')`)===true);
  await done(); await open();
  ck('the channel id is stored',
     (await serverSettings()).discordChannelId==='123456789012345678',
     JSON.stringify((await serverSettings()).discordChannelId));

  await ev(`(()=>{const i=${channelField};
    i.value='not-a-snowflake';
    i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await done();
  ck('a channel id that is not an id is refused',
     (await serverSettings()).discordChannelId==='123456789012345678',
     JSON.stringify((await serverSettings()).discordChannelId));
  ck('and the field snaps back to what is stored',
     await ev(`${channelField}.value`)==='123456789012345678',
     await ev(`${channelField}.value`));

  console.log('--- switching it off hides the field again ---');
  await ev(`${channelBox('discord')}.click()`); await sleep(500);
  ck('the field is gone', await ev(`!${webhookField}`)===true);
  await done();
  ck('but the URL is NOT discarded — only hidden',
     (await serverSettings()).discordWebhook===WEBHOOK);
  ck('and the list no longer holds discord',
     JSON.stringify((await serverSettings()).notifyChannels)==='["android"]',
     JSON.stringify((await serverSettings()).notifyChannels));

  // Leave nothing behind that would have the server's notifier posting to a
  // webhook that does not exist.
  await ev(`fetch('/api/settings',{method:'DELETE',credentials:'same-origin'}).then(r=>r.ok)`);

  console.log(fails===0?'\nALL NOTIFY CHECKS PASSED':`\n${fails} FAILED`);
}catch(e){console.error('ERR',e.message);fails++;}
finally{await closeChrome({ chrome, port: PORT, profile });process.exit(fails?1:0);}
