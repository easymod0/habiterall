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
// These suites exercise the API, not sign-in or rate limiting, and auth now
// defaults ON — see shared/src/password.js. Both are turned off explicitly here,
// before the server module is imported, exactly as HABITERALL_DB must be: a
// suite that writes a few hundred entries in a burst is what the 300/minute API
// limit is meant to catch, and here that burst is the point.
process.env.HABITERALL_AUTH = 'off';
process.env.HABITERALL_RATE_LIMIT = 'off';
process.env.HABITERALL_DB = join(workdir, 'notify.db');

const { app } = await import('../src/server.js');
const notifier = await import('../src/notifier.js');
const { deliverAccount } = await import('@habiterall/shared/notify-send.js');
const { handleInteraction, INTERACTION, MAX_ANSWER_AGE_DAYS } = await import('@habiterall/shared/discord.js');
const { signNtfyAnswer, NTFY_ANSWER_PATH } = await import('@habiterall/shared/ntfy-answer.js');
const { RATE_LIMITS } = await import('@habiterall/shared/security.js');
const { sessionSecret } = await import('../src/auth.js');

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
  //
  // And it must fall OUTSIDE the fixture calendar, which is the half that was
  // missing. Every other instant in this file is an absolute day in August 2026
  // (`TODAY` through `TODAY + 5`), so "two days ago" walks into that window for
  // six real dates a year — and ticking the habit on a fixture day makes that
  // day's delivery `done_today`, so nothing is sent, no outcome is recorded,
  // and the checks below read a status row that was never written. Measured on
  // 2026-08-17: `twoDaysAgo` was 2026-08-15, which is `deliverOn(15, 500)`, and
  // the three transient-failure checks failed with the feature working
  // perfectly. Master was green the day before and red the day after, on a
  // suite nobody had touched.
  //
  // So it is clamped to the day before the calendar starts. That is still a
  // real past date whenever the clamp fires — it only fires once the real today
  // has reached the window, which is after it.
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 10);
  const dayBefore = stamp(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000);
  const twoDaysAgo = (() => {
    const real = stamp(Date.now() - 2 * 86_400_000);
    return real < TODAY ? real : dayBefore;
  })();
  const [y, m, d] = twoDaysAgo.split('-').map(Number);
  const doneDay = new Date(Date.UTC(y, m - 1, d, 8, 0));

  // Named, so a future edit that moves the fixture calendar fails HERE rather
  // than as three confusing assertions about a delivery status two screens
  // down. This is the invariant; the checks below only depend on it.
  ck('the ticked day is outside the fixture calendar', twoDaysAgo < TODAY,
    `${twoDaysAgo} must be before ${TODAY}`);

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

  /** One day's delivery, collected fresh so the stored verdict is re-read. */
  const deliverOn = async (day, status) => {
    const instant = new Date(Date.UTC(2026, 7, day, 8, 0));
    await deliverAccount(notifier.collect(instant)[0], {
      instant,
      mark: notifier.mark,
      recordOutcome: notifier.recordOutcome,
      fetch: fakeFetch(status),
      log: { warn: () => {}, debug: () => {} },
    });
    return (await api('/api/notify/status')).body.channels
      .find((c) => c.channel === 'discord');
  };

  // Day one: Discord is having a bad afternoon. Retryable, so the reminder is
  // not written off — but the user is still owed an explanation.
  const transient = await deliverOn(15, 500);
  ck('a delivery failure is readable over the API',
    transient?.ok === false, JSON.stringify(transient));
  ck('a retryable one is not reported as permanent',
    transient?.permanent === false && transient?.status === 500,
    JSON.stringify(transient));
  ck('dated from when it started going wrong',
    transient?.date === '2026-08-15', transient?.date);

  // REGRESSION. Day two: the webhook is deleted. Both days are `ok: false`, so
  // a change test that looked only at THAT wrote nothing here — and the dialog
  // went on saying "webhook returned 500" forever while the one actionable
  // sentence Discord gave us, "create a new one", never reached the person who
  // could act on it. Which is the same silence this feature exists to end.
  const permanent = await deliverOn(16, 404);
  ck('a failure that changes its REASON is written down',
    /deleted|create a new one/i.test(permanent?.error ?? ''), permanent?.error);
  ck('and updates whether it is worth retrying',
    permanent?.permanent === true && permanent?.status === 404,
    JSON.stringify(permanent));
  ck('and re-dates itself to when the new state began',
    permanent?.date === '2026-08-16', permanent?.date);

  // Day three: the same failure again. Nothing new to say, so nothing is
  // written — the date stays at when this state began, which is what the
  // dialog's "not delivered since" reads from. The row must not vanish either.
  const repeated = await deliverOn(17, 404);
  ck('an unchanged failure is not rewritten every day',
    repeated?.date === '2026-08-16' && repeated?.status === 404,
    JSON.stringify(repeated));

  // ...and a working send clears it, which is what makes the notice go away.
  const cleared = await deliverOn(18, 204);
  ck('a success clears the failure', cleared?.ok === true, JSON.stringify(cleared));
  ck('and the timestamp is ISO, as the cloud edition also reports it',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(cleared?.at ?? ''), cleared?.at);

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

  // #221 gave an avoided habit (show_as: 'avoid' + at_most + numerical) Clean /
  // Slipped buttons carrying the ordinary yes/no actions, but `record()` mapped
  // them with the fixed boolean encoding — inverted for this habit shape, and
  // invisible in the reply text, which says "Clean" either way. This is the
  // "output that reached the platform" half: a real press, through the real
  // adapter, read back from storage. Assert the STORED VALUE, never the label.
  //
  // `target_value: 2`, not 0 — a limit of 0 makes `target + 1` equal to a
  // hardcoded 1, which would pass even with the fix reverted to `{ value: 1 }`.
  // This edition is deliberately the one that carries the wiring proof: the
  // cloud suite (habiterall-cloud/test/notify.integration.mjs) keeps its
  // avoided fixture at `target_value: 0`, so the two together cover both the
  // degenerate case and the one that actually pins `target + 1`.
  const avoided = await api('/api/habits', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Smoking', type: 'numerical', target_type: 'at_most',
      target_value: 2, show_as: 'avoid',
    }),
  });
  const avoidedId = avoided.body.id;

  await press(`hab|${avoidedId}|${day}|yes`);
  const avoidedAfterYes = await api(`/api/habits/${avoidedId}/entries`);
  ck('pressing Clean (yes) on an avoided habit stores 0, not YES',
    avoidedAfterYes.body.some((e) => e.date === day && e.value === 0 && e.status === ''),
    JSON.stringify(avoidedAfterYes.body.filter((e) => e.date === day)));

  await press(`hab|${avoidedId}|${day}|no`);
  const avoidedAfterNo = await api(`/api/habits/${avoidedId}/entries`);
  ck('pressing Slipped (no) on an avoided habit stores target+1 (3), not UNSET',
    avoidedAfterNo.body.some((e) => e.date === day && e.value === 3 && e.status === ''),
    JSON.stringify(avoidedAfterNo.body.filter((e) => e.date === day)));

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

  /* ---------- a quick answer preserves that day's note (#224) ---------- */
  //
  // The issue's own measurement: a note written through the ordinary PUT,
  // then a shade/Discord-style press that never carries `notes` at all —
  // `answerBody` has no such field. Every case here goes through a path that
  // OMITS the key, since a test that writes a note and reads it straight back
  // cannot fail.

  const notesHabit = await api('/api/habits', {
    method: 'POST', body: JSON.stringify({ name: 'Notes preserve' }),
  });
  const notesId = notesHabit.body.id;
  const NOTE = 'coach said 10, only managed 8';

  // 1. The issue's own measurement.
  await api(`/api/habits/${notesId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2, notes: NOTE }),
  });
  await press(`hab|${notesId}|${day}|yes`);
  const afterPress = await api(`/api/habits/${notesId}/entries`);
  const pressedRow = afterPress.body.find((e) => e.date === day);
  ck('a quick Yes through the real adapter keeps the day\'s note',
    pressedRow?.value === 2 && pressedRow?.notes === NOTE,
    JSON.stringify(pressedRow));

  // 2. PUT omitting the key preserves.
  const omitHabit = await api('/api/habits', {
    method: 'POST', body: JSON.stringify({ name: 'Notes omit' }),
  });
  const omitId = omitHabit.body.id;
  await api(`/api/habits/${omitId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2, notes: NOTE }),
  });
  await api(`/api/habits/${omitId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2 }),
  });
  const afterOmit = await api(`/api/habits/${omitId}/entries`);
  ck('a PUT that omits notes preserves the stored note',
    afterOmit.body.find((e) => e.date === day)?.notes === NOTE,
    JSON.stringify(afterOmit.body.find((e) => e.date === day)));

  // 3. PUT notes:'' still clears.
  const clearHabit = await api('/api/habits', {
    method: 'POST', body: JSON.stringify({ name: 'Notes clear' }),
  });
  const clearId = clearHabit.body.id;
  await api(`/api/habits/${clearId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2, notes: NOTE }),
  });
  await api(`/api/habits/${clearId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2, notes: '' }),
  });
  const afterClear = await api(`/api/habits/${clearId}/entries`);
  ck('an explicit empty notes still clears the stored note',
    afterClear.body.find((e) => e.date === day)?.notes === '',
    JSON.stringify(afterClear.body.find((e) => e.date === day)));

  // 4. The echo is the row, not the request, on a preserve.
  const echoHabit = await api('/api/habits', {
    method: 'POST', body: JSON.stringify({ name: 'Notes echo' }),
  });
  const echoId = echoHabit.body.id;
  await api(`/api/habits/${echoId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2, notes: NOTE }),
  });
  const echoOmit = await api(`/api/habits/${echoId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2 }),
  });
  ck('the response echoes the stored note, not the omitted request body',
    echoOmit.body.notes === NOTE, JSON.stringify(echoOmit.body));

  // 5. The echo on a clear.
  const echoClear = await api(`/api/habits/${echoId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2, notes: '' }),
  });
  ck('the response echoes the cleared note',
    echoClear.body.notes === '', JSON.stringify(echoClear.body));

  // 6. A skip preserves too.
  const skipHabit = await api('/api/habits', {
    method: 'POST', body: JSON.stringify({ name: 'Notes skip' }),
  });
  const skipId = skipHabit.body.id;
  await api(`/api/habits/${skipId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ value: 2, notes: NOTE }),
  });
  const skipPut = await api(`/api/habits/${skipId}/entries/${day}`, {
    method: 'PUT', body: JSON.stringify({ status: 'skip' }),
  });
  const afterSkipPreserve = await api(`/api/habits/${skipId}/entries`);
  ck('a skip preserves the stored note',
    afterSkipPreserve.body.find((e) => e.date === day)?.notes === NOTE,
    JSON.stringify(afterSkipPreserve.body.find((e) => e.date === day)));
  ck('and the reply still reports the SKIP wire value',
    skipPut.body.value === 3, JSON.stringify(skipPut.body));

  /* ---------- answering from an ntfy button ---------- */
  //
  // Reached over the real route (`NTFY_ANSWER_PATH`), not by calling
  // `handleNtfyAnswer` directly — the point is to prove the MOUNTING as well as
  // the handler: that the route sits where an unauthenticated request can reach
  // it, that its own inline limiter bites regardless of
  // `HABITERALL_RATE_LIMIT=off` (set for this whole file), and that the origin
  // guard mounted above it applies here too.

  const ntfySecret = sessionSecret();
  let ntfyRequests = 0;
  const postNtfy = async (code, { origin } = {}) => {
    ntfyRequests++;
    const headers = {};
    if (origin !== undefined) headers.Origin = origin;
    const res = await fetch(
      `${base}${NTFY_ANSWER_PATH}?c=${encodeURIComponent(code)}`,
      { method: 'POST', headers }
    );
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body };
  };
  const ntfyCode = (fields) => signNtfyAnswer({ secret: ntfySecret, account: '', ...fields });
  const shiftDay = (delta) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };

  // A fresh habit per test below, so "nothing written" reads unambiguously off
  // an otherwise-empty entry list rather than off a habit other tests already
  // touched.
  const freshHabit = async (name) => {
    const created = await api('/api/habits', { method: 'POST', body: JSON.stringify({ name }) });
    return created.body.id;
  };

  // A signed press records the entry, read back from storage.
  const happyId = await freshHabit('ntfy happy path');
  const happy = await postNtfy(ntfyCode({ habitId: happyId, date: day, action: 'yes' }));
  ck('a signed ntfy press is accepted', happy.status === 200, JSON.stringify(happy));
  const afterHappy = await api(`/api/habits/${happyId}/entries`);
  ck('and the entry is recorded, read back from storage',
    afterHappy.body.some((e) => e.date === day && e.value === 2),
    JSON.stringify(afterHappy.body.filter((e) => e.date === day)));

  // A forged code (the MAC does not verify) is refused and nothing is written.
  const forgedNtfyId = await freshHabit('ntfy forged');
  const validForForgery = ntfyCode({ habitId: forgedNtfyId, date: day, action: 'yes' });
  // Flipping the LAST base64url character is not safe: a 16-byte MAC encodes to
  // 22 characters, and the final one carries only 2 significant bits, the rest
  // padding — so some characters (e.g. 'A' and 'B') decode to the identical MAC
  // and "tampering" this way is a no-op about 1 time in 64. Flip a whole byte
  // in the middle of the decoded MAC instead, which always changes the value.
  const [version, payloadB64, macB64] = validForForgery.split('.');
  const macBytes = Buffer.from(macB64, 'base64url');
  macBytes[0] ^= 0xff;
  const tamperedMac = `${version}.${payloadB64}.${macBytes.toString('base64url')}`;
  const forgedNtfy = await postNtfy(tamperedMac);
  ck('a forged code is refused with 403', forgedNtfy.status === 403, JSON.stringify(forgedNtfy));
  const afterForgedNtfy = await api(`/api/habits/${forgedNtfyId}/entries`);
  ck('and nothing was written for it',
    !afterForgedNtfy.body.some((e) => e.date === day),
    JSON.stringify(afterForgedNtfy.body));

  // A reference to an account that does not exist (this edition has exactly
  // one, named by the empty reference) gets the SAME 403 a forgery gets — the
  // route must not be an oracle for which accounts exist.
  const unknownAccountId = await freshHabit('ntfy unknown account');
  const unknownAccountCode = signNtfyAnswer({
    secret: ntfySecret, account: 'someone-else', habitId: unknownAccountId, date: day, action: 'yes',
  });
  const unknownAccount = await postNtfy(unknownAccountCode);
  ck('an unknown account reference is refused with the identical 403',
    unknownAccount.status === 403
      && JSON.stringify(unknownAccount.body) === JSON.stringify(forgedNtfy.body),
    JSON.stringify(unknownAccount));
  const afterUnknownAccount = await api(`/api/habits/${unknownAccountId}/entries`);
  ck('and nothing was written for it either',
    !afterUnknownAccount.body.some((e) => e.date === day),
    JSON.stringify(afterUnknownAccount.body));

  // A habit that no longer exists: refused, and nothing written (there is
  // nothing left to write to, which is the point).
  const deletedId = await freshHabit('ntfy deleted');
  await api(`/api/habits/${deletedId}`, { method: 'DELETE' });
  const deletedCode = ntfyCode({ habitId: deletedId, date: day, action: 'yes' });
  const deletedNtfy = await postNtfy(deletedCode);
  ck('a deleted habit is refused, not recorded',
    deletedNtfy.status === 400 && /no longer exists/i.test(deletedNtfy.body?.error ?? ''),
    JSON.stringify(deletedNtfy));

  // A date older than MAX_ANSWER_AGE_DAYS is stale — 410.
  const staleId = await freshHabit('ntfy stale');
  const staleDate = shiftDay(-(MAX_ANSWER_AGE_DAYS + 1));
  const staleCode = ntfyCode({ habitId: staleId, date: staleDate, action: 'yes' });
  const staleNtfy = await postNtfy(staleCode);
  ck('a stale reminder answers 410', staleNtfy.status === 410, JSON.stringify(staleNtfy));
  const afterStale = await api(`/api/habits/${staleId}/entries`);
  ck('and nothing was written for a stale press',
    afterStale.body.length === 0, JSON.stringify(afterStale.body));

  // A date in the future is malformed intent, not staleness — 400.
  const futureId = await freshHabit('ntfy future');
  const futureDate = shiftDay(1);
  const futureCode = ntfyCode({ habitId: futureId, date: futureDate, action: 'yes' });
  const futureNtfy = await postNtfy(futureCode);
  ck('a future-dated reminder answers 400', futureNtfy.status === 400, JSON.stringify(futureNtfy));
  const afterFuture = await api(`/api/habits/${futureId}/entries`);
  ck('and nothing was written for a future press',
    afterFuture.body.length === 0, JSON.stringify(afterFuture.body));

  // A test code — the button a "send a test notification" press carries — is
  // live but inert: 200, and it never reaches storage.
  const testId = await freshHabit('ntfy test-code target');
  const testCode = ntfyCode({ habitId: testId, date: day, action: 'yes', test: true });
  const testNtfy = await postNtfy(testCode);
  ck('a test code is accepted', testNtfy.status === 200, JSON.stringify(testNtfy));
  const afterTest = await api(`/api/habits/${testId}/entries`);
  ck('and a test code writes nothing', afterTest.body.length === 0, JSON.stringify(afterTest.body));

  // No Origin header (ntfy's subscribing device, like the Android client,
  // sends none) is accepted; a foreign Origin is refused by the same guard
  // that protects the rest of the app — its own test, not inherited from
  // Android's.
  const noOriginId = await freshHabit('ntfy no origin');
  const noOrigin = await postNtfy(
    ntfyCode({ habitId: noOriginId, date: day, action: 'yes' })
  );
  ck('no Origin header is accepted', noOrigin.status === 200, JSON.stringify(noOrigin));

  const foreignOriginId = await freshHabit('ntfy foreign origin');
  const foreignOrigin = await postNtfy(
    ntfyCode({ habitId: foreignOriginId, date: day, action: 'yes' }),
    { origin: 'https://evil.example' }
  );
  ck('a foreign Origin is refused, even with an otherwise-valid code',
    foreignOrigin.status === 403 && /cross-origin/i.test(foreignOrigin.body?.error ?? ''),
    JSON.stringify(foreignOrigin));
  const afterForeignOrigin = await api(`/api/habits/${foreignOriginId}/entries`);
  ck('and nothing was written for the cross-origin attempt',
    afterForeignOrigin.body.length === 0, JSON.stringify(afterForeignOrigin.body));

  // The limiter is written inline at the route rather than through the
  // switchable `limit()` helper, specifically so it still bites with
  // HABITERALL_RATE_LIMIT=off (set for this entire file) — proven behaviourally
  // here, not by reading the source, because a source-text guard cannot see a
  // renamed binding or a limiter quietly routed through the pass-through
  // helper. Budgeted against requests this file has already sent through the
  // same limiter (`ntfyRequests`), since they share one window and one key.
  const junkCode = 'v1.notarealtoken.notarealmac12345678';
  let saw429 = false;
  const budget = RATE_LIMITS.ntfyAnswer.limit + 20 - ntfyRequests;
  for (let i = 0; i < budget && !saw429; i++) {
    const r = await postNtfy(junkCode);
    if (r.status === 429) saw429 = true;
  }
  ck('the ntfy-answer limiter still bites with HABITERALL_RATE_LIMIT=off',
    saw429, `sent ${ntfyRequests} requests total, limit is ${RATE_LIMITS.ntfyAnswer.limit}/min`);

  /* ---------- whose day is it ---------- */
  //
  // Everything above runs at `notifyTimezone: 'UTC'` against instants built
  // with `Date.UTC`, which makes the account's zone unfalsifiable there:
  // hard-coding `zonedClock(now, 'UTC')` in the notifier — the setting ignored
  // outright — passes every check in this file. `zonedClock` itself is unit
  // tested; what is not is this edition's WIRING of the setting into
  // `collect`, and that is the half that decides which calendar day
  // "already done" and "already sent" are asked about.
  //
  // 22:00 UTC on the 10th is 07:00 on the 11th in Tokyo. The entry is written
  // on the TOKYO date, so a notifier reading the server's day looks at the
  // 10th, finds nothing, and reports the habit as still needing its nudge.
  // Both dates are in the past, because `PUT /entries/:date` refuses a future
  // one against the SERVER's day — which is its own problem and not this
  // test's.
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      notifyChannels: ['discord'],
      discordWebhook: WEBHOOK,
      discordChannelId: '',
      notifyTimezone: 'Asia/Tokyo',
    }),
  });
  const tokyoInstant = new Date(Date.UTC(2026, 7, 10, 22, 0));
  const tokyoDate = '2026-08-11';
  const utcDate = '2026-08-10';

  const zoned = await api('/api/habits', {
    method: 'POST',
    body: JSON.stringify({ name: 'Zoned', reminder_time: '07:00' }),
  });
  await api(`/api/habits/${zoned.body.id}/entries/${tokyoDate}`, {
    method: 'PUT', body: JSON.stringify({ value: 2 }),
  });

  const tokyoAccount = notifier.collect(tokyoInstant)[0];
  ck("the account's own day decides what counts as answered, not the server's",
    tokyoAccount?.doneToday?.has(zoned.body.id) === true,
    `doneToday=${JSON.stringify([...(tokyoAccount?.doneToday ?? [])])} ` +
    `tokyo=${tokyoDate} utc=${utcDate}`);
  /* ---------- the reminder follows the device, unless told not to ---------- */
  //
  // End to end: the header a client already sends on every request reaches
  // storage, and the tick reads it back. `notifyTimezone` is left at `auto` for
  // the first half — the default — so this is the path an account that has
  // never opened the settings dialog takes.
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      notifyChannels: ['discord'],
      discordWebhook: WEBHOOK,
      discordChannelId: '',
      notifyTimezone: 'auto',
    }),
  });
  // 22:00 UTC on the 10th is 07:00 on the 11th in Tokyo, so the two calendars
  // disagree at this instant — which is the only way to tell them apart.
  const followInstant = new Date(Date.UTC(2026, 7, 10, 22, 0));
  const followed = await api('/api/habits', {
    method: 'POST',
    body: JSON.stringify({ name: 'Followed', reminder_time: '07:00' }),
  });
  await api(`/api/habits/${followed.body.id}/entries/2026-08-11`, {
    method: 'PUT', body: JSON.stringify({ value: 2 }),
  });

  // No header sent yet, so nothing has been reported and the server's own
  // clock stands: on the server's 10th, the Tokyo-dated answer is unseen.
  ck('with no device reported, the account is on the server\'s clock',
    notifier.collect(followInstant)[0]?.doneToday?.has(followed.body.id) === false,
    'the server has no reason to think otherwise yet');

  // One ordinary request, carrying the header every client already sends.
  await fetch(`${base}/api/habits`, {
    headers: { 'Content-Type': 'application/json',
      'X-Habiterall-Timezone': 'Asia/Tokyo' },
  });

  ck('a device that checked in moves the account to its clock',
    notifier.collect(followInstant)[0]?.doneToday?.has(followed.body.id) === true,
    'no extra request — the header rode on GET /api/habits');

  // ...and naming a zone beats the device, which is how somebody abroad keeps
  // their reminders on home time.
  await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ notifyTimezone: 'UTC' }),
  });
  ck('a named zone wins over whatever the device says',
    notifier.collect(followInstant)[0]?.doneToday?.has(followed.body.id) === false,
    'the account asked for UTC and must stay there');

  // The device's report is NOT the setting: switching back to auto restores it,
  // which is only possible because the two are stored apart.
  await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ notifyTimezone: 'auto' }),
  });
  ck('and switching back to automatic is a way back, not a one-way door',
    notifier.collect(followInstant)[0]?.doneToday?.has(followed.body.id) === true,
    'the reported zone survived the detour through an explicit one');

  // Through `deliverAccount`, not only `collect`. The bug this whole change
  // leads with — `deliverAccount` re-deriving the zone from the raw setting,
  // so an `auto` account had its dueness judged on the server's clock and
  // reported `too_late` — was pinned ONLY by the cloud suite, which needs
  // Postgres. `deliverAccount` is shared code; the edition that runs without a
  // database should catch it too.
  await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ notifyTimezone: 'auto' }),
  });
  const dueHabit = await api('/api/habits', {
    method: 'POST',
    body: JSON.stringify({ name: 'Due on the device clock', reminder_time: '07:00' }),
  });
  const fetchZone = fakeFetch();
  const zoneDelivery = await deliverAccount(notifier.collect(followInstant)[0], {
    instant: followInstant, mark: notifier.mark, fetch: fetchZone,
    log: { debug: () => {}, info: () => {}, warn: () => {} },
  });
  ck('a reminder is DUE on the device\'s clock, not just answered on it',
    zoneDelivery.sent >= 1 && (zoneDelivery.skipped?.too_late ?? 0) === 0,
    `${JSON.stringify(zoneDelivery)} habit=${dueHabit.body.id}`);

  ck('a reported zone is never exported',
    !JSON.stringify(await (await fetch(`${base}/api/export`)).json())
      .includes('Asia/Tokyo'),
    'restoring a backup abroad must not move when reminders arrive');

  /* ---------- housekeeping must not abandon the tick ---------- */
  //
  // Pruning old watermark rows is the FIRST thing a tick does, and it used to be
  // unguarded — so a stray lock on `notify_log` threw out of `collect`, which is
  // awaited before `runTick`'s per-account try, and the tick ended before a
  // single reminder had been considered. Cloud has always guarded its own
  // `prune`; this was the asymmetry.
  //
  // A `BEFORE DELETE` trigger is the lock, without needing a second process.
  // SQLite fires triggers FOR EACH ROW, so there has to be a row old enough to
  // delete or nothing happens and the check passes vacuously.
  const { db } = await import('../src/db.js');
  db.exec(`INSERT INTO notify_log (habit_id, channel, date)
           VALUES (${habitId}, 'discord', '2020-01-01')`);
  db.exec(`CREATE TRIGGER busy_prune BEFORE DELETE ON notify_log
           BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);

  // `createLogger`'s write is resolved at emit time, so patching stdout after
  // import is enough to read what the tick said.
  const lines = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    // `startNotifier` ticks immediately, which is the whole point of using it
    // rather than calling `collect` — the guard is in the wrapper `start`
    // installs, not in `collect` itself.
    notifier.start({ ...process.env, HABITERALL_NOTIFY: 'on' }).stop();
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    process.stdout.write = realWrite;
    db.exec('DROP TRIGGER busy_prune');
  }
  const said = lines.join('');
  ck('a stray lock on the watermark table is reported, not fatal',
    /notify\.prune_failed/.test(said), said.slice(0, 400));
  ck('and the tick was not abandoned before it looked at a habit',
    !/notify\.collect_failed/.test(said), said.slice(0, 400));

  // `start()`'s own startup line, not a second log call — no
  // HABITERALL_PUBLIC_URL / PUBLIC_URL is set anywhere in this suite, so ntfy's
  // buttons have nowhere to post back to and the line has to say so, since
  // nothing else does (root CLAUDE.md, "the operator has no way to know
  // buttons are off").
  const startLine = lines.find((l) => l.includes('"msg":"notify.starting"'));
  ck('the startup line reports whether ntfy answers are reachable',
    /"ntfy_answers":"off"/.test(startLine ?? ''), startLine ?? '(no notify.starting line captured)');

  // ...and the other side of the same line: a configured public address turns
  // it on, so this is a wired predicate and not a field that always reads
  // "off".
  const lines2 = [];
  process.stdout.write = (chunk) => { lines2.push(String(chunk)); return true; };
  try {
    notifier.start({
      ...process.env, HABITERALL_NOTIFY: 'on', HABITERALL_PUBLIC_URL: 'https://habits.example.com',
    }).stop();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.stdout.write = realWrite;
  }
  const startLine2 = lines2.find((l) => l.includes('"msg":"notify.starting"'));
  ck('...and reachable once HABITERALL_PUBLIC_URL is set',
    /"ntfy_answers":"on"/.test(startLine2 ?? ''), startLine2 ?? '(no notify.starting line captured)');

  console.log(`\n${fails ? `${fails} check(s) failed` : 'all checks passed'}`);
} finally {
  server.close();
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
