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

  /* ---------- a failure the user can see ---------- */
  //
  // The watermark above answers "has it gone yet". This answers the question
  // the user actually asks — "why did it never arrive?" — which before had no
  // surface at all: a deleted webhook was recorded as sent, logged at warn, and
  // the habit, its time and the destination toggle all went on looking correct.

  const failDay = new Date(Date.UTC(2026, 7, 15, 8, 0));
  await deliverAccount(notifier.collect(failDay)[0], {
    instant: failDay,
    mark: notifier.mark,
    recordOutcome: notifier.recordOutcome,
    fetch: fakeFetch(404),           // the webhook was deleted
    log: { warn: () => {}, debug: () => {} },
  });

  const failed = await api('/api/notify/status');
  const discord = failed.body.channels.find((c) => c.channel === 'discord');
  ck('a permanent delivery failure is readable over the API',
    discord?.ok === false && discord?.permanent === true, JSON.stringify(failed.body));
  ck('and carries the sender\'s own words rather than a code',
    /webhook/i.test(discord?.error ?? ''), discord?.error);
  ck('filed under the day the reminder was for',
    discord?.date === '2026-08-15', discord?.date);

  // The second failing day says nothing new, so nothing is written — but the
  // row must not vanish either.
  const stillFailing = new Date(Date.UTC(2026, 7, 16, 8, 0));
  await deliverAccount(
    { ...notifier.collect(stillFailing)[0] },
    {
      instant: stillFailing,
      mark: notifier.mark,
      recordOutcome: notifier.recordOutcome,
      fetch: fakeFetch(404),
      log: { warn: () => {}, debug: () => {} },
    }
  );
  const stillThere = await api('/api/notify/status');
  ck('a second failing day leaves the report where it was',
    stillThere.body.channels.find((c) => c.channel === 'discord')?.date === '2026-08-15',
    JSON.stringify(stillThere.body.channels));

  // ...and a working send clears it, which is what makes the notice go away.
  const fixedDay = new Date(Date.UTC(2026, 7, 17, 8, 0));
  await deliverAccount(notifier.collect(fixedDay)[0], {
    instant: fixedDay,
    mark: notifier.mark,
    recordOutcome: notifier.recordOutcome,
    fetch: fakeFetch(204),
    log: { warn: () => {}, debug: () => {} },
  });
  const cleared = await api('/api/notify/status');
  ck('a success clears the failure',
    cleared.body.channels.find((c) => c.channel === 'discord')?.ok === true,
    JSON.stringify(cleared.body.channels));

  /* ---------- switching it off ---------- */

  await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ notifyChannels: ['android'] }),
  });
  ck('with only on-device delivery the notifier visits nobody',
    notifier.collect(AT_0800).length === 0);

  /* ---------- bot mode, with no webhook at all ---------- */
  //
  // REGRESSION. `CHANNELS.discord.ready` is "a webhook URL OR (a bot AND a
  // channel id)", and `collect` did not pass the bot half — so the recommended
  // setup, a channel id with no webhook, reported as nothing to deliver and this
  // returned [] on every tick, in silence, forever. `sendTest` did pass it,
  // which is why the test button worked and only real reminders never arrived.
  // That is a bug report that leads everyone to inspect Discord, the one part
  // that was working.
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      notifyChannels: ['discord'],
      discordChannelId: '123456789012345678',
      discordWebhook: '',
    }),
  });

  const noBot = notifier.collect(AT_0800);
  ck('without a bot token, a channel id alone is not deliverable',
    noBot.length === 0, JSON.stringify(noBot.length));

  process.env.DISCORD_BOT_TOKEN = 'test-token-not-a-real-one';
  const withBot = notifier.collect(AT_0800);
  ck('with a bot token, a channel id and no webhook IS collected',
    withBot.length === 1 && withBot[0].habits.length === 1,
    `collected ${withBot.length}`);

  // And the same settings must reach the same verdict through both doors: the
  // scheduler and the test button. They disagreed, and nothing noticed.
  const { serverChannels } = await import('@habiterall/shared/notify.js');
  ck('the scheduler and the test button agree on what is configured',
    serverChannels(withBot[0].settings, { bot: true }).join() === 'discord',
    JSON.stringify(serverChannels(withBot[0].settings, { bot: true })));

  delete process.env.DISCORD_BOT_TOKEN;
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      notifyChannels: ['android'], discordChannelId: '', discordWebhook: WEBHOOK,
    }),
  });

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
  // A row holding 0, exactly as the API would: an answer of "no" is an answer,
  // and it overwrites the skip above rather than deleting the day. It used to
  // remove the row, which made "I missed it" indistinguishable from a day nobody
  // had been asked about — see `entryWrite`.
  ck('pressing No records a lapse, exactly as the API would',
    afterNo.body.some((e) => e.date === day && e.value === 0 && e.status === ''),
    JSON.stringify(afterNo.body.filter((e) => e.date === day)));

  const wrongChannel = [];
  await handleInteraction({
    id: 'i2', token: 't', type: INTERACTION.COMPONENT,
    channel_id: '999999999999999999',
    data: { custom_id: `hab|${habitId}|${day}|yes` },
    message: { embeds: [] },
  }, { ...adapter, respond: async (i, r) => { wrongChannel.push(r); } });
  ck('a click from another channel writes nothing',
    wrongChannel.at(-1)?.data?.flags === 64, JSON.stringify(wrongChannel.at(-1)));

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
    /no longer exists/i.test(forged.at(-1)?.data?.content ?? ''), JSON.stringify(forged.at(-1)));

  console.log(`\n${fails ? `${fails} check(s) failed` : 'all checks passed'}`);
} finally {
  server.close();
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
