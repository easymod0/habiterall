/**
 * The reminder pipeline against a real database.
 *
 * The scheduling rules are unit-tested in shared/test/notify.test.js with no
 * storage at all. What cannot be tested there is the half that makes the
 * feature work once: that the watermark actually survives a round trip through
 * SQLite, so a reminder delivered at 08:00 is not delivered again at 08:01.
 * Every tick reads that table; a mistake in it means duplicate pings once a
 * minute for half an hour.
 *
 *   node test/notify.integration.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'habiterall-notify-'));
process.env.HABITERALL_DB = join(workdir, 'notify.db');

const { app } = await import('../src/server.js');
const notifier = await import('../src/notifier.js');
const { deliverAccount } = await import('@habiterall/shared/notify-send.js');
const { handleInteraction, INTERACTION } = await import('@habiterall/shared/discord.js');

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const api = async (path, init = {}) => {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' }, ...init,
  });
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body };
};

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/test-token';

/** A fetch stand-in: nothing here may touch the real Discord. */
function fakeFetch(status = 204) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status, headers: { get: () => null } };
  };
  doFetch.calls = calls;
  return doFetch;
}

/** 08:00 UTC on a fixed day, so the test does not depend on when it is run. */
const AT_0800 = new Date(Date.UTC(2026, 7, 13, 8, 0));
const TODAY = '2026-08-13';

try {
  /* ---------- settings ---------- */

  const saved = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      notifyChannels: ['discord', 'android'],
      discordWebhook: `${WEBHOOK}?wait=true`,
      notifyTimezone: 'UTC',
    }),
  });
  ck('settings accept a Discord destination', saved.status === 200, JSON.stringify(saved.body));
  ck('the webhook is stored canonicalised, without its query string',
    saved.body.settings.discordWebhook === WEBHOOK, saved.body.settings.discordWebhook);
  ck('the channel list is stored in registry order',
    JSON.stringify(saved.body.settings.notifyChannels) === '["android","discord"]',
    JSON.stringify(saved.body.settings.notifyChannels));

  const hostile = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ discordWebhook: 'https://169.254.169.254/api/webhooks/1/a' }),
  });
  ck('a webhook pointed off Discord is refused',
    hostile.body.ignored.includes('discordWebhook'), JSON.stringify(hostile.body));
  const still = await api('/api/settings');
  ck('and the previously stored webhook is untouched',
    still.body.discordWebhook === WEBHOOK, still.body.discordWebhook);

  /* ---------- a habit with a reminder ---------- */

  const created = await api('/api/habits', {
    method: 'POST',
    body: JSON.stringify({ name: 'Meditate', reminder_time: '08:00' }),
  });
  ck('a habit can carry a reminder time', created.body.reminder_time === '08:00');
  const habitId = created.body.id;

  await api('/api/habits', {
    method: 'POST',
    body: JSON.stringify({ name: 'No reminder set' }),
  });

  /* ---------- the tick ---------- */

  const collected = notifier.collect(AT_0800);
  ck('the account is collected once a server destination is configured',
    collected.length === 1, JSON.stringify(collected.map((a) => a.habits?.length)));
  ck('only habits with a reminder time are considered',
    collected[0].habits.length === 1);

  const fetch1 = fakeFetch();
  const first = await deliverAccount(collected[0], {
    instant: AT_0800, mark: notifier.mark, fetch: fetch1,
  });
  ck('the reminder is delivered', first.sent === 1 && first.failed === 0,
    JSON.stringify(first));
  ck('it went to the stored webhook', fetch1.calls[0]?.url === WEBHOOK,
    fetch1.calls[0]?.url);
  ck('the payload names the habit',
    fetch1.calls[0]?.body?.embeds?.[0]?.title === 'Meditate',
    JSON.stringify(fetch1.calls[0]?.body));
  ck('the payload cannot ping a channel',
    JSON.stringify(fetch1.calls[0]?.body?.allowed_mentions) === '{"parse":[]}');

  // The point of the whole file: re-collect, exactly as the next tick a minute
  // later would, and the watermark written above must suppress it.
  const reCollected = notifier.collect(AT_0800);
  ck('the account is still visited a minute later', reCollected.length === 1);
  const fetch2 = fakeFetch();
  await deliverAccount(reCollected[0], {
    instant: AT_0800, mark: notifier.mark, fetch: fetch2,
  });
  ck('the same minute does not send twice (watermark round trip)',
    fetch2.calls.length === 0, `posted ${fetch2.calls.length} times`);

  const nextDay = new Date(Date.UTC(2026, 7, 14, 8, 0));
  const fetch3 = fakeFetch();
  await deliverAccount(notifier.collect(nextDay)[0], {
    instant: nextDay, mark: notifier.mark, fetch: fetch3,
  });
  ck('tomorrow is a new day and does send', fetch3.calls.length === 1);

  /* ---------- already done ---------- */

  // A real past date: entries in the future are refused, so this one cannot be
  // a fixture like the days above — it has to be relative to the actual today.
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const [y, m, d] = twoDaysAgo.split('-').map(Number);
  const doneDay = new Date(Date.UTC(y, m - 1, d, 8, 0));

  const ticked = await api(`/api/habits/${habitId}/entries/${twoDaysAgo}`, {
    method: 'PUT', body: JSON.stringify({ value: 2 }),
  });
  ck('the habit can be ticked off for that day', ticked.status === 200,
    JSON.stringify(ticked.body));

  const fetch4 = fakeFetch();
  await deliverAccount(notifier.collect(doneDay)[0], {
    instant: doneDay, mark: notifier.mark, fetch: fetch4,
  });
  ck('a habit already ticked off today is not nagged', fetch4.calls.length === 0,
    `posted ${fetch4.calls.length} times`);

  /* ---------- switching it off ---------- */

  await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ notifyChannels: ['android'] }),
  });
  ck('with only on-device delivery the notifier visits nobody',
    notifier.collect(AT_0800).length === 0);

  /* ---------- the test endpoint ---------- */

  await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ notifyChannels: ['android'] }),
  });
  const noTarget = await api('/api/notify/test', { method: 'POST', body: '{}' });
  ck('a test with no server destination reports nothing to do',
    noTarget.status === 200 && noTarget.body.results.length === 0,
    JSON.stringify(noTarget.body));

  /* ---------- answering from a Discord button ---------- */
  //
  // The unit tests cover the handler's own logic against a fake adapter. What
  // only a real database can show is that a click writes the SAME row the API
  // would have written — the whole reason `entryWrite` is shared.

  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ discordChannelId: '123456789012345678' }),
  });

  const adapter = notifier.interactionAdapter();
  const sent = [];
  const press = (customId, extra = {}) => handleInteraction({
    id: 'i1',
    token: 'tok',
    type: INTERACTION.COMPONENT,
    channel_id: '123456789012345678',
    member: { user: { id: '999999999999999999' } },
    message: { embeds: [{ title: 'Did you exercise today?' }] },
    data: { custom_id: customId },
    ...extra,
  }, { ...adapter, respond: async (i, r) => { sent.push(r); } });

  const day = new Date().toISOString().slice(0, 10);

  await press(`hab|${habitId}|${day}|yes`);
  const afterYes = await api(`/api/habits/${habitId}/entries`);
  ck('pressing Yes records a completion',
    afterYes.body.some((e) => e.date === day && e.value === 2),
    JSON.stringify(afterYes.body.filter((e) => e.date === day)));
  ck('and the message is updated rather than replied to',
    sent.at(-1)?.type === 7 &&
    sent.at(-1)?.data?.embeds?.[0]?.fields?.[0]?.value === 'Done',
    JSON.stringify(sent.at(-1)));
  ck('with the buttons removed, so it cannot be pressed twice',
    JSON.stringify(sent.at(-1)?.data?.components) === '[]');

  await press(`hab|${habitId}|${day}|skip`);
  const afterSkip = await api(`/api/habits/${habitId}/entries`);
  ck('pressing Skip stores a skip out of band, not the value 3',
    afterSkip.body.some((e) => e.date === day && e.status === 'skip' && e.value === 0),
    JSON.stringify(afterSkip.body.filter((e) => e.date === day)));

  await press(`hab|${habitId}|${day}|no`);
  const afterNo = await api(`/api/habits/${habitId}/entries`);
  ck('pressing No removes the row, exactly as the API would',
    !afterNo.body.some((e) => e.date === day),
    JSON.stringify(afterNo.body.filter((e) => e.date === day)));

  const wrongChannel = [];
  await handleInteraction({
    id: 'i2', token: 't', type: INTERACTION.COMPONENT,
    channel_id: '999999999999999999',
    data: { custom_id: `hab|${habitId}|${day}|yes` },
    message: { embeds: [] },
  }, { ...adapter, respond: async (i, r) => { wrongChannel.push(r); } });
  ck('a click from another channel writes nothing',
    wrongChannel[0]?.data?.flags === 64, JSON.stringify(wrongChannel[0]));

  // A forged habit id: the account is resolved from the channel, and the habit
  // is looked up inside it, so this finds nothing rather than someone else's.
  const forged = [];
  await handleInteraction({
    id: 'i3', token: 't', type: INTERACTION.COMPONENT,
    channel_id: '123456789012345678',
    data: { custom_id: `hab|999999|${day}|yes` },
    message: { embeds: [] },
  }, { ...adapter, respond: async (i, r) => { forged.push(r); } });
  ck('a habit id that is not ours is refused',
    /no longer exists/i.test(forged[0]?.data?.content ?? ''), JSON.stringify(forged[0]));

  console.log(`\n${fails ? `${fails} check(s) failed` : 'all checks passed'}`);
} finally {
  server.close();
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
