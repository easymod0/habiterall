import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  CHANNELS, CHANNEL_IDS, CATCH_UP_MINUTES, DEFAULT_CHANNELS,
  answeredIds, channelConfigured, discordPayload, dueReminders, enabledChannels,
  minutesOfDay, needsServerDelivery, parseChannelList, parseDiscordWebhook,
  parseTimeZone, reminderMessage, serverChannels, zonedClock,
} = await import('../src/notify.js');

const { deliverAccount, postWebhook, resetSaid, runTick, sendToChannel, warnUnreachable } =
  await import('../src/notify-send.js');

const { parseSettings } = await import('../src/validate.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A habit with a reminder, overridable per test. */
const habit = (over = {}) => ({
  id: 1, name: 'Meditate', description: '', type: 'boolean', unit: '',
  target_value: 0, target_type: 'at_least', freq_numerator: 1,
  freq_denominator: 1, color: '#3b82f6', reminder_time: '08:00',
  archived: false, ...over,
});

/** An instant, given as UTC parts. */
const utc = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi));

/* ---------- the registry and the UI must agree ---------- */

test('every channel offered in the UI is one the server knows', () => {
  // ui/settings.js declares what the dialog renders and notify.js declares
  // what the server delivers. A channel in one and not the other is either a
  // dead control or a destination nobody can switch on.
  const ui = readFileSync(join(root, 'public', 'ui', 'settings.js'), 'utf8');
  const block = /const CHANNEL_OPTIONS = \[([\s\S]*?)\n\];/.exec(ui);
  assert.ok(block, 'failed to find CHANNEL_OPTIONS in ui/settings.js');

  const offered = [...block[1].matchAll(/\{ value: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(offered, [...CHANNEL_IDS],
    'the UI channel list must match CHANNELS in shared/src/notify.js, in order');
});

test('every channel declares how it is delivered', () => {
  for (const [id, channel] of Object.entries(CHANNELS)) {
    assert.ok(['device', 'server'].includes(channel.delivery),
      `${id} has no usable delivery`);
    assert.ok(Array.isArray(channel.configKeys), `${id} has no configKeys`);
  }
});

/* ---------- webhook URLs ---------- */

test('a real Discord webhook URL is accepted and canonicalised', () => {
  const url = 'https://discord.com/api/webhooks/123456789012345678/aB3-_xYz';
  assert.equal(parseDiscordWebhook(url), url);
  assert.equal(parseDiscordWebhook(`  ${url}  `), url);
  assert.equal(parseDiscordWebhook(`${url}?wait=true`), url,
    'the query string must be dropped, not stored for the server to fetch');
  assert.equal(parseDiscordWebhook(`${url}#frag`), url);
  assert.equal(
    parseDiscordWebhook('https://DISCORD.COM/api/webhooks/1/abc'),
    'https://discord.com/api/webhooks/1/abc'
  );
  assert.equal(
    parseDiscordWebhook('https://discord.com/api/v10/webhooks/1/abc'),
    'https://discord.com/api/v10/webhooks/1/abc'
  );
  assert.equal(parseDiscordWebhook('https://ptb.discord.com/api/webhooks/1/abc'),
    'https://ptb.discord.com/api/webhooks/1/abc');
  assert.equal(parseDiscordWebhook('https://discordapp.com/api/webhooks/1/abc'),
    'https://discordapp.com/api/webhooks/1/abc');
});

test('an empty webhook means "not configured", not an error', () => {
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(parseDiscordWebhook(blank), '');
  }
});

test('the webhook host allowlist closes off request forgery', () => {
  // The SERVER fetches this URL, so anything that is not Discord is a way to
  // aim it at the private network and read the result back as a status code.
  const hostile = [
    'http://discord.com/api/webhooks/1/abc',            // plaintext
    'https://169.254.169.254/api/webhooks/1/abc',       // cloud metadata
    'https://localhost/api/webhooks/1/abc',
    'https://127.0.0.1:5432/api/webhooks/1/abc',
    'https://10.0.0.5/api/webhooks/1/abc',
    'https://discord.com.evil.test/api/webhooks/1/abc', // suffix trick
    'https://evil.test/api/webhooks/1/abc',
    'https://notdiscord.com/api/webhooks/1/abc',
    'https://user:pass@discord.com/api/webhooks/1/abc', // credentials
    'file:///etc/passwd',
    'gopher://discord.com/api/webhooks/1/abc',
    'https://discord.com/api/webhooks/1/abc/../../admin', // path escape
    'https://discord.com/login',                         // right host, wrong path
    'javascript:alert(1)',
    'not a url at all',
    `https://discord.com/api/webhooks/1/${'a'.repeat(300)}`, // over the length cap
  ];
  for (const url of hostile) {
    assert.equal(parseDiscordWebhook(url), undefined, `accepted ${url}`);
  }
});

test('an embedded-credential URL cannot smuggle a host past the allowlist', () => {
  // The classic: everything before the last @ is userinfo, so the real host is
  // evil.test. Rejected for the host, not merely for the credentials.
  assert.equal(
    parseDiscordWebhook('https://discord.com@evil.test/api/webhooks/1/abc'),
    undefined
  );
});

/* ---------- channel lists and time zones ---------- */

test('a channel list is normalised, not trusted', () => {
  assert.deepEqual(parseChannelList(['discord', 'android']), ['android', 'discord'],
    'stored in registry order so the value is canonical');
  assert.deepEqual(parseChannelList(['android', 'android']), ['android']);
  assert.deepEqual(parseChannelList([]), []);
  assert.deepEqual(parseChannelList(['android', 'telegram']), ['android'],
    'an unknown id is dropped so an older server tolerates a newer client');
  for (const bad of ['android', null, 42, { android: true }]) {
    assert.equal(parseChannelList(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

test('an account that has never touched the setting gets the defaults', () => {
  assert.deepEqual(enabledChannels({}), [...DEFAULT_CHANNELS]);
  assert.deepEqual(enabledChannels(), [...DEFAULT_CHANNELS]);
  // An explicit empty list is a choice, not an absence: it must not be
  // overwritten by the defaults, or "no notifications at all" is unreachable.
  assert.deepEqual(enabledChannels({ notifyChannels: [] }), []);
});

test('a channel is only ready when its configuration is filled in', () => {
  assert.equal(channelConfigured('android', {}), true, 'needs nothing');
  assert.equal(channelConfigured('discord', {}), false);
  assert.equal(channelConfigured('discord', { discordWebhook: '' }), false);
  assert.equal(channelConfigured('discord', { discordWebhook: 'x' }), true);
  assert.equal(channelConfigured('__proto__', {}), false,
    'a key from a request body must not resolve to Object.prototype');
});

test('the server only delivers for channels that are on, its own, and ready', () => {
  const url = 'https://discord.com/api/webhooks/1/abc';

  assert.deepEqual(serverChannels({ notifyChannels: ['android'], discordWebhook: url }), [],
    'the phone delivers its own alarms');
  assert.deepEqual(serverChannels({ notifyChannels: ['discord'] }), [],
    'enabled but unconfigured is not deliverable');
  assert.deepEqual(
    serverChannels({ notifyChannels: ['android', 'discord'], discordWebhook: url }),
    ['discord']
  );
  assert.equal(needsServerDelivery({ notifyChannels: ['android'] }), false);
  assert.equal(
    needsServerDelivery({ notifyChannels: ['discord'], discordWebhook: url }), true);
});

test('a time zone is validated by asking Intl, not by pattern', () => {
  assert.equal(parseTimeZone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(parseTimeZone('UTC'), 'UTC');
  assert.equal(parseTimeZone(''), '');
  // Shaped like a zone, and not one. Storing it would throw inside the
  // notifier tick — on a schedule, for one user, where nobody sees it.
  assert.equal(parseTimeZone('Europe/Atlantis'), undefined);
  assert.equal(parseTimeZone('Not/A/Zone'), undefined);
  assert.equal(parseTimeZone('a'.repeat(200)), undefined);
});

/* ---------- the settings surface ---------- */

test('the notification settings go through the same validator as the rest', () => {
  const url = 'https://discord.com/api/webhooks/123/abc';
  const { accepted, rejected } = parseSettings({
    notifyChannels: ['discord', 'android'],
    discordWebhook: `${url}?wait=true`,
    notifyTimezone: 'America/Toronto',
  });

  assert.deepEqual(accepted, {
    notifyChannels: ['android', 'discord'],
    discordWebhook: url,
    notifyTimezone: 'America/Toronto',
  }, 'a normaliser stores what it returns, not what arrived');
  assert.deepEqual(rejected, []);
});

test('a rejected notification setting is dropped like any other bad value', () => {
  const { accepted, rejected } = parseSettings({
    discordWebhook: 'https://evil.test/api/webhooks/1/abc',
    notifyTimezone: 'Mars/Olympus',
    notifyChannels: 'android',
    dayOrder: 'newest-left',
  });
  assert.deepEqual(accepted, { dayOrder: 'newest-left' });
  assert.deepEqual(rejected.sort(),
    ['discordWebhook', 'notifyChannels', 'notifyTimezone']);
});

/* ---------- the clock ---------- */

test('the local clock is read in the account\'s own zone', () => {
  // 2026-08-13 23:30 UTC is already the 14th in Tokyo and still the 13th in
  // Toronto. Both the date and the minute-of-day have to follow the zone: the
  // date keys the "already sent" watermark.
  const instant = utc(2026, 8, 13, 23, 30);

  assert.deepEqual(zonedClock(instant, 'UTC'),
    { date: '2026-08-13', time: '23:30', minutes: 23 * 60 + 30 });
  assert.deepEqual(zonedClock(instant, 'Asia/Tokyo'),
    { date: '2026-08-14', time: '08:30', minutes: 8 * 60 + 30 });
  assert.deepEqual(zonedClock(instant, 'America/Toronto'),
    { date: '2026-08-13', time: '19:30', minutes: 19 * 60 + 30 });
});

test('midnight is hour 00, not hour 24', () => {
  // With `hour12: false` en-US resolves to the h24 cycle and formats midnight
  // as '24' — so a 00:00 reminder would be compared against 1440 minutes and
  // could never fire, while the date beside it stayed correct.
  const clock = zonedClock(utc(2026, 8, 13, 0, 0), 'UTC');
  assert.equal(clock.time, '00:00');
  assert.equal(clock.minutes, 0);
  assert.equal(clock.date, '2026-08-13');
});

test('a reminder keeps its wall time across a DST change', () => {
  // Toronto springs forward on 2026-03-08. 08:00 local is 13:00 UTC before and
  // 12:00 UTC after; computing in UTC offsets would drift the reminder by an
  // hour for half the year.
  const before = zonedClock(utc(2026, 3, 7, 13, 0), 'America/Toronto');
  const after = zonedClock(utc(2026, 3, 9, 12, 0), 'America/Toronto');
  assert.equal(before.time, '08:00');
  assert.equal(after.time, '08:00');
});

test('minutesOfDay only accepts a real HH:MM', () => {
  assert.equal(minutesOfDay('00:00'), 0);
  assert.equal(minutesOfDay('08:30'), 510);
  assert.equal(minutesOfDay('23:59'), 1439);
  for (const bad of ['', '8:30', '24:00', '23:60', 'ab:cd', null, undefined, '08:30:00']) {
    assert.equal(minutesOfDay(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

/* ---------- what is due ---------- */

const dueAt = (isoUtc, over = {}, args = {}) => dueReminders({
  habits: [habit(over)],
  instant: new Date(isoUtc),
  timeZone: 'UTC',
  ...args,
});

test('a reminder fires in its own minute', () => {
  const due = dueAt('2026-08-13T08:00:00Z');
  assert.equal(due.length, 1);
  assert.deepEqual(
    { date: due[0].date, time: due[0].time },
    { date: '2026-08-13', time: '08:00' }
  );
});

test('a reminder does not fire before its time', () => {
  assert.deepEqual(dueAt('2026-08-13T07:59:00Z'), []);
});

test('a missed reminder is caught up, but only briefly', () => {
  // The server may have been restarting. Half an hour late is still useful;
  // six hours late is a lie, and waking up after a day of downtime must not
  // fire a day of reminders at once.
  assert.equal(dueAt(`2026-08-13T08:${String(CATCH_UP_MINUTES).padStart(2, '0')}:00Z`).length, 1);
  assert.equal(dueAt('2026-08-13T08:31:00Z').length, 0);
  assert.equal(dueAt('2026-08-13T14:00:00Z').length, 0);
});

test('a reminder whose window straddles midnight is dropped, not re-dated', () => {
  // 23:50 with the next tick at 00:05 the following day. Sending it then would
  // file it under tomorrow's date — misreporting the day AND consuming
  // tomorrow's slot, so tomorrow's real reminder would never go.
  const late = habit({ reminder_time: '23:50' });
  assert.equal(dueReminders({
    habits: [late], instant: new Date('2026-08-14T00:05:00Z'), timeZone: 'UTC',
  }).length, 0);
  assert.equal(dueReminders({
    habits: [late], instant: new Date('2026-08-13T23:55:00Z'), timeZone: 'UTC',
  }).length, 1);
});

test('habits without a reminder, or archived, are never due', () => {
  assert.deepEqual(dueAt('2026-08-13T08:00:00Z', { reminder_time: '' }), []);
  assert.deepEqual(dueAt('2026-08-13T08:00:00Z', { archived: true }), []);
});

test('every reason a reminder is not sent reports itself', () => {
  // Six conditions decide this and none is visible from outside, so a reminder
  // that does not arrive looks identical to a broken webhook — which sends
  // people to check the part that is working. `too_late` is the one nobody
  // guesses: a time already past on the server's clock is not late, it is gone
  // until tomorrow, and that is what an unset container timezone produces.
  const reasons = (instant, over = {}, extra = {}) => {
    const seen = [];
    dueReminders({
      habits: [habit(over)], instant: new Date(instant), timeZone: 'UTC',
      onSkip: (h, reason, detail) => seen.push({ reason, ...detail }),
      ...extra,
    });
    return seen;
  };

  assert.deepEqual(reasons('2026-08-13T08:00:00Z'), [], 'a due reminder is not a skip');

  assert.equal(reasons('2026-08-13T08:00:00Z', { archived: true })[0].reason, 'archived');
  assert.equal(reasons('2026-08-13T08:00:00Z', { reminder_time: '' })[0].reason,
    'no_reminder_time');

  const early = reasons('2026-08-13T07:30:00Z')[0];
  assert.deepEqual(
    { reason: early.reason, at: early.at, in_minutes: early.in_minutes },
    { reason: 'not_yet', at: '08:00', in_minutes: 30 }
  );

  const late = reasons('2026-08-13T20:23:00Z')[0];
  assert.deepEqual(
    { reason: late.reason, late_minutes: late.late_minutes, catch_up: late.catch_up },
    { reason: 'too_late', late_minutes: 743, catch_up: CATCH_UP_MINUTES }
  );

  assert.equal(
    reasons('2026-08-13T08:00:00Z', {}, { doneToday: new Set([1]) })[0].reason,
    'done_today');
  assert.equal(
    reasons('2026-08-13T08:00:00Z', {}, { alreadySent: () => true })[0].reason,
    'already_sent');

  // Both of those are asked before lateness, and that ordering is what makes
  // `too_late` mean a reminder was lost: at 20:23 the window is long closed for
  // every habit, including the one whose reminder went out on time at 08:00.
  assert.equal(
    reasons('2026-08-13T20:23:00Z', {}, { alreadySent: () => true })[0].reason,
    'already_sent');
  assert.equal(
    reasons('2026-08-13T20:23:00Z', {}, { doneToday: new Set([1]) })[0].reason,
    'done_today');

  // The clock it judged against, on every skip — the field that makes a
  // timezone mistake self-evident instead of a hypothesis.
  assert.deepEqual(
    { now: late.now, date: late.date, zone: late.zone },
    { now: '20:23', date: '2026-08-13', zone: 'UTC' }
  );
});

test('a habit already done today is not nagged', () => {
  const done = dueAt('2026-08-13T08:00:00Z', {}, { doneToday: new Set([1]) });
  assert.deepEqual(done, []);
});

test('a reminder already sent today is not sent again', () => {
  const args = { alreadySent: (id, date) => id === 1 && date === '2026-08-13' };
  assert.deepEqual(dueAt('2026-08-13T08:00:00Z', {}, args), []);
  // The next day is a different key, so it fires again.
  assert.equal(dueAt('2026-08-14T08:00:00Z', {}, args).length, 1);
});

test('the due date follows the user\'s zone, not the server\'s', () => {
  // 08:00 in Tokyo on the 14th is 23:00 UTC on the 13th. A watermark written
  // under the UTC date would be the wrong day for this user.
  const due = dueReminders({
    habits: [habit()],
    instant: utc(2026, 8, 13, 23, 0),
    timeZone: 'Asia/Tokyo',
  });
  assert.equal(due.length, 1);
  assert.equal(due[0].date, '2026-08-14');
});

test('answeredIds asks isCompleted, so a numerical 3 is an amount', () => {
  const habits = [
    habit({ id: 1, type: 'boolean' }),
    habit({ id: 2, type: 'numerical', target_value: 3, target_type: 'at_least' }),
    habit({ id: 3, type: 'numerical', target_value: 3, target_type: 'at_least' }),
    habit({ id: 4, type: 'numerical', target_value: 8, target_type: 'at_least' }),
    habit({ id: 5, type: 'boolean' }),
  ];
  const done = answeredIds(habits, [
    { habit_id: 1, value: 2, status: '' },     // a checkmark
    { habit_id: 2, value: 3, status: '' },     // three of something: done
    { habit_id: 3, value: 3, status: 'skip' }, // a skip that happens to hold 3
    { habit_id: 4, value: 3, status: '' },     // three of eight: not done
    { habit_id: 5, value: 0, status: '' },     // a 'no' kept alive by a note
  ]);
  // 3 is there because a skip is an ANSWER; 4 and 5 are not, because a partial
  // amount and an explicit 'no' are days that still deserve a nudge. Asking for
  // the merely *completed* ids nagged about every skipped day; asking whether a
  // row exists — which is what the phone used to do — silenced 4 and 5 too.
  assert.deepEqual([...done].sort(), [1, 2, 3]);
});

/* ---------- what it says ---------- */

test('the reminder text describes the goal it is reminding about', () => {
  assert.match(reminderMessage(habit()).body, /have you done this today/i);
  assert.match(
    reminderMessage(habit({ type: 'numerical', target_value: 8, unit: 'glasses' })).body,
    /at least 8 glasses/
  );
  assert.match(
    reminderMessage(habit({
      type: 'numerical', target_value: 2, target_type: 'at_most', unit: 'cigarettes',
    })).body,
    /at most 2 cigarettes/
  );
  assert.match(reminderMessage(habit(), { test: true }).body, /test notification/i);
});

test('a target is not scaled by 1000 — only entry values are', () => {
  // Scaling the target once turned "at most 2 times" into "at most 0.002".
  const body = reminderMessage(habit({
    type: 'numerical', target_value: 2, target_type: 'at_most', unit: '',
  })).body;
  assert.match(body, /at most 2\b/);
  assert.doesNotMatch(body, /0\.002/);
});

test('a Discord payload carries the habit, its colour, and no mentions', () => {
  const payload = discordPayload({
    habit: habit({ description: 'ten minutes' }),
    message: reminderMessage(habit()),
    date: '2026-08-13',
    appUrl: 'https://habits.example/',
  });

  const [embed] = payload.embeds;
  assert.equal(embed.title, 'Meditate');
  assert.equal(embed.color, 0x3b82f6);
  assert.equal(embed.footer.text, '2026-08-13');
  assert.equal(embed.url, 'https://habits.example/');
  assert.deepEqual(embed.fields, [{ name: 'Notes', value: 'ten minutes' }]);
  // A habit may be named '@everyone'. Embeds do not resolve mentions today,
  // but this is the guarantee rather than an accident of where the text sits.
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('a Discord payload omits what it does not know', () => {
  const payload = discordPayload({ habit: habit(), message: reminderMessage(habit()) });
  const [embed] = payload.embeds;
  assert.equal(embed.url, undefined, 'no invented link when no public URL is set');
  assert.equal(embed.fields, undefined);
  assert.equal(embed.footer, undefined);
});

test('the app link ends in exactly one slash, however many were configured', () => {
  const link = (appUrl) => discordPayload({
    habit: habit(), message: reminderMessage(habit()), appUrl,
  }).embeds[0].url;

  assert.equal(link('https://habits.example'), 'https://habits.example/');
  assert.equal(link('https://habits.example/'), 'https://habits.example/');
  assert.equal(link('https://habits.example///'), 'https://habits.example/');
  assert.equal(link('https://habits.example/app/'), 'https://habits.example/app/');
  assert.equal(link('ftp://habits.example'), undefined);

  // The regex this replaced was `/\/+$/`, unanchored at the start: on a run of
  // slashes with no match at the end, the engine retries from every one of them.
  const started = process.hrtime.bigint();
  link(`https://habits.example/${'/'.repeat(200_000)}x`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 500, `trailing-slash normalisation took ${ms}ms`);
});

test('an over-long name or note is truncated to Discord\'s limits', () => {
  const payload = discordPayload({
    habit: habit({ name: 'n'.repeat(400), description: 'd'.repeat(2000) }),
    message: reminderMessage(habit({ name: 'n'.repeat(400) })),
  });
  const [embed] = payload.embeds;
  assert.equal(embed.title.length, 256);
  assert.equal(embed.fields[0].value.length, 1024);
});

/* ---------- delivery ---------- */

/** A fetch stand-in that records what it was asked to do. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const doFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      headers: { get: (h) => next.headers?.[h.toLowerCase()] ?? null },
    };
  };
  doFetch.calls = calls;
  return doFetch;
}

test('a successful post reports ok', async () => {
  const fetch = fakeFetch([{ status: 204 }]);
  const result = await postWebhook('https://discord.com/api/webhooks/1/a', { x: 1 },
    { fetch });

  assert.deepEqual(result, { ok: true, status: 204 });
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.redirect, 'manual',
    'following a redirect would walk straight around the host allowlist');
  assert.deepEqual(fetch.calls[0].body, { x: 1 });
});

test('a deleted webhook is a permanent failure, not something to retry', async () => {
  for (const status of [401, 403, 404]) {
    const result = await postWebhook('https://discord.com/api/webhooks/1/a', {},
      { fetch: fakeFetch([{ status }]) });
    assert.equal(result.ok, false);
    assert.equal(result.permanent, true, `${status} should be permanent`);
  }
});

test('a 500 or a timeout is a retryable failure', async () => {
  const server = await postWebhook('https://discord.com/api/webhooks/1/a', {},
    { fetch: fakeFetch([{ status: 500 }]) });
  assert.equal(server.ok, false);
  assert.ok(!server.permanent);

  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const timeout = await postWebhook('https://discord.com/api/webhooks/1/a', {},
    { fetch: fakeFetch([aborted]) });
  assert.equal(timeout.ok, false);
  assert.ok(!timeout.permanent);
  assert.match(timeout.error, /no response within/);
});

test('a 429 reports how long Discord asked us to wait', async () => {
  const result = await postWebhook('https://discord.com/api/webhooks/1/a', {},
    { fetch: fakeFetch([{ status: 429, headers: { 'retry-after': '2.5' } }]) });
  assert.equal(result.ok, false);
  assert.equal(result.retryAfterMs, 2500);
});

test('a 429 with no advice still asks for a wait, not zero', async () => {
  // Zero would read as "no wait requested" and therefore as "do not retry",
  // turning a transient limit into a dropped reminder.
  for (const headers of [undefined, { 'retry-after': 'soon' }, { 'retry-after': '0' }]) {
    const result = await postWebhook('https://discord.com/api/webhooks/1/a', {},
      { fetch: fakeFetch([{ status: 429, headers }]) });
    assert.ok(result.retryAfterMs > 0, `${JSON.stringify(headers)} gave ${result.retryAfterMs}`);
  }
  // And an absurd one is capped rather than parking the tick for an hour.
  const capped = await postWebhook('https://discord.com/api/webhooks/1/a', {},
    { fetch: fakeFetch([{ status: 429, headers: { 'retry-after': '99999' } }]) });
  assert.equal(capped.retryAfterMs, 60_000);
});

test('a device channel is never posted anywhere', async () => {
  const fetch = fakeFetch([{ status: 204 }]);
  const result = await sendToChannel('android', { habit: habit(), settings: {} }, { fetch });
  assert.equal(result.ok, false);
  assert.equal(fetch.calls.length, 0);
});

/* ---------- a whole tick ---------- */

const account = (over = {}) => ({
  id: 7,
  settings: {
    notifyChannels: ['android', 'discord'],
    discordWebhook: 'https://discord.com/api/webhooks/1/abc',
    notifyTimezone: 'UTC',
  },
  habits: [habit()],
  doneToday: new Set(),
  alreadySent: () => false,
  ...over,
});

test('a tick delivers what is due and records it', async () => {
  const marked = [];
  const fetch = fakeFetch([{ status: 204 }]);

  const result = await runTick({
    collect: () => [account()],
    mark: (acc, habitId, channel, date) => marked.push([acc.id, habitId, channel, date]),
    instant: utc(2026, 8, 13, 8, 0),
    fetch,
  });

  assert.deepEqual(result, { accounts: 1, sent: 1, failed: 0, skipped: {} });
  assert.deepEqual(marked, [[7, 1, 'discord', '2026-08-13']]);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].url, /^https:\/\/discord\.com\/api\/webhooks\//);
});

test('a collect that throws is named, not left to a printf', async () => {
  // The one outcome in this module that produced no `notify.*` event: a total
  // read failure fell out of `runTick` to `startNotifier`'s
  // `log.error('notify: tick failed:', err)`, which is the least greppable line
  // in the file. It still ends the tick — there is nothing to deliver — but it
  // says so in the same shape as everything else.
  const errors = [];
  const result = await runTick({
    collect: () => { throw new Error('pool timeout'); },
    mark: () => {},
    instant: utc(2026, 8, 13, 8, 0),
    log: { error: (event) => errors.push(event) },
  });

  assert.deepEqual(result, { accounts: 0, sent: 0, failed: 0, skipped: {} });
  assert.deepEqual(errors, ['notify.collect_failed']);
});

test('collect is handed the tick\'s own instant', async () => {
  // Not left to read its own clock: it has to resolve the user's local date to
  // answer "already sent today", and two clock reads either side of local
  // midnight would check yesterday's watermark against today's date.
  let seen;
  await runTick({
    collect: (instant) => { seen = instant; return []; },
    mark: () => {},
    instant: utc(2026, 8, 13, 8, 0),
  });
  assert.equal(Number(seen), Number(utc(2026, 8, 13, 8, 0)));
});

test('a failed send is not recorded, so the next tick retries it', async () => {
  const marked = [];
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: (...args) => marked.push(args),
    fetch: fakeFetch([{ status: 500 }]),
    log: { warn: () => {} },
  });

  assert.deepEqual(result, { sent: 0, failed: 1, skipped: {} });
  assert.deepEqual(marked, [], 'a retryable failure must leave the slot open');
});

test('a permanently failed send IS recorded, so it is not retried all day', async () => {
  const marked = [];
  await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: (...args) => marked.push(args),
    fetch: fakeFetch([{ status: 404 }]),
    log: { warn: () => {} },
  });
  assert.equal(marked.length, 1, 'a deleted webhook will not start working before midnight');
});

test('a watermark that will not store does not abandon the account', async () => {
  // `mark` was the one storage call in the loop with nothing around it, beside a
  // `noteOutcome` that has had a try/catch since it was written — and on the
  // cloud side it opens its own pool connection per habit, so pool exhaustion
  // reaches it first. An exception unwound `deliverAccount` entirely: the habit
  // whose reminder had JUST been delivered took the two behind it down with it,
  // never attempted, and `runTick` reported `sent: 0` about a message the user
  // was looking at.
  const errors = [];
  const three = account({
    habits: [habit({ id: 1 }), habit({ id: 2 }), habit({ id: 3 })],
  });
  const fetch = fakeFetch([{ status: 204 }]);

  const result = await deliverAccount(three, {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => { throw new Error('pool timeout'); },
    fetch,
    log: { error: (event, fields) => errors.push([event, fields.habit]) },
  });

  assert.equal(fetch.calls.length, 3, 'every due habit is still attempted');
  assert.deepEqual(result, { sent: 3, failed: 0, skipped: {} },
    'and a delivered reminder is reported as delivered');
  // Loud, because the consequence outlives the tick: with no watermark the next
  // minute re-sends, for the whole catch-up window.
  assert.deepEqual(errors, [
    ['notify.watermark_not_stored', 1],
    ['notify.watermark_not_stored', 2],
    ['notify.watermark_not_stored', 3],
  ]);
});

test('a failure is written down where the user can see it', async () => {
  // The whole point: a deleted webhook was recorded as sent, logged at warn, and
  // that was the ONLY surface. Reminders stopped while the habit, its time and
  // the destination toggle all went on looking correct — and on a shared
  // instance the log is unreachable to the person it concerns.
  const outcomes = [];
  await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: (acc, channel, outcome) => outcomes.push({ user: acc.id, channel, ...outcome }),
    fetch: fakeFetch([{ status: 404 }]),
    log: { warn: () => {} },
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, false);
  assert.equal(outcomes[0].channel, 'discord');
  assert.equal(outcomes[0].permanent, true);
  assert.equal(outcomes[0].date, '2026-08-13');
  // The sender's own words, not a second phrasing invented for the UI.
  assert.match(outcomes[0].error, /webhook/i);
});

test('an outcome is written when it CHANGES, not once per reminder', async () => {
  // Five habits failing at 08:00 is one piece of news, not five writes — and the
  // second through fifth say nothing the first did not.
  const outcomes = [];
  const ctx = {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: (acc, channel, outcome) => outcomes.push({ channel, ok: outcome.ok }),
    log: { warn: () => {} },
  };
  const three = account({
    habits: [habit({ id: 1 }), habit({ id: 2 }), habit({ id: 3 })],
  });

  await deliverAccount(three, { ...ctx, fetch: fakeFetch([{ status: 404 }]) });
  assert.deepEqual(outcomes, [{ channel: 'discord', ok: false }]);

  // A tick that finds it still broken, for the same reason, has nothing new to
  // say. `delivered` carries the stored REASON and not just `ok`, so that the
  // reason changing IS news — the test below this one is why.
  const gone = {
    discord: {
      ok: false,
      status: 404,
      error: 'the webhook was deleted or is no longer accepted — create a new one',
      permanent: true,
    },
  };
  outcomes.length = 0;
  await deliverAccount({ ...three, delivered: gone },
    { ...ctx, fetch: fakeFetch([{ status: 404 }]) });
  assert.deepEqual(outcomes, [], 'the same failure was written twice');

  // ...and a success once it is fixed IS news, because it clears the notice the
  // user is being shown.
  outcomes.length = 0;
  await deliverAccount({ ...three, delivered: gone },
    { ...ctx, fetch: fakeFetch([{ status: 204 }]) });
  assert.deepEqual(outcomes, [{ channel: 'discord', ok: true }]);

  // A healthy instance writes to this table roughly never.
  outcomes.length = 0;
  await deliverAccount(
    { ...three, delivered: { discord: { ok: true, status: 204, error: undefined } } },
    { ...ctx, fetch: fakeFetch([{ status: 204 }]) });
  assert.deepEqual(outcomes, []);
});

test('a failure that changes its REASON is news, even though it is still a failure', async () => {
  // REGRESSION. Both a 500 and a deleted webhook are `ok: false`, so a change
  // test that compares only that wrote nothing for the second — and the user
  // was shown "webhook returned 500" indefinitely while the one actionable
  // sentence Discord gave us, "create a new one", never arrived. A softer
  // version of the exact silence this feature exists to end.
  const outcomes = [];
  const ctx = {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: (_a, channel, outcome) => outcomes.push({ channel, ...outcome }),
    log: { warn: () => {} },
  };

  const wasFlaky = account({
    delivered: {
      discord: { ok: false, status: 500, error: 'webhook returned 500', permanent: false },
    },
  });
  await deliverAccount(wasFlaky, { ...ctx, fetch: fakeFetch([{ status: 404 }]) });

  assert.equal(outcomes.length, 1, 'the reason changed and was not written down');
  assert.equal(outcomes[0].permanent, true);
  assert.equal(outcomes[0].status, 404);
  assert.match(outcomes[0].error, /deleted|create a new one/i);
  // ...and the date moves with it, because what is stored is when THIS state
  // began — which is what the dialog's "not delivered since" reads from.
  assert.equal(outcomes[0].date, '2026-08-13');

  // The identical failure again says nothing new. This is the half that keeps
  // it from being a write per reminder, so it has to survive the fix above.
  outcomes.length = 0;
  const wasGone = account({
    delivered: {
      discord: {
        ok: false,
        status: 404,
        error: 'the webhook was deleted or is no longer accepted — create a new one',
        permanent: true,
      },
    },
  });
  await deliverAccount(wasGone, { ...ctx, fetch: fakeFetch([{ status: 404 }]) });
  assert.deepEqual(outcomes, [], 'the same failure was written twice');
});

test('one channel\'s verdict does not stand in for another\'s', async () => {
  // `delivered` is per channel and the comparison must be too, or a working
  // webhook would vouch for a broken bot. Two destinations, one of each.
  const outcomes = [];
  const both = account({
    settings: {
      notifyChannels: ['android', 'discord'],
      discordWebhook: 'https://discord.com/api/webhooks/1/abc',
      notifyTimezone: 'UTC',
    },
    delivered: { discord: { ok: true, status: 204 } },
  });

  await deliverAccount(both, {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: (_a, channel, outcome) => outcomes.push({ channel, ok: outcome.ok }),
    fetch: fakeFetch([{ status: 404 }]),
    log: { warn: () => {} },
  });

  // Android is delivered by the phone and never reaches a send, so the only
  // verdict here is Discord's own.
  assert.deepEqual(outcomes, [{ channel: 'discord', ok: false }]);
});

test('failing to STORE an outcome does not fail the delivery', async () => {
  // This is a diagnostic bolted onto the send. The reminder has already gone
  // out (or already not); losing the note about it must not cost the reminder,
  // and must not take the rest of the tick's accounts down with it.
  const errors = [];
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: () => { throw new Error('storage gone'); },
    fetch: fakeFetch([{ status: 204 }]),
    log: { warn: () => {}, error: (msg) => errors.push(msg) },
  });

  assert.deepEqual(result, { sent: 1, failed: 0, skipped: {} });
  assert.deepEqual(errors, ['notify.outcome_not_stored']);
});

test('an edition that supplies no recordOutcome still delivers', async () => {
  // The adapter property is optional, and both editions had shipped without it.
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    fetch: fakeFetch([{ status: 204 }]),
    log: { warn: () => {} },
  });
  assert.deepEqual(result, { sent: 1, failed: 0, skipped: {} });
});

test('a reminder lost to the catch-up window is a warning, once', async () => {
  // Every other skip is a normal outcome. This one means the reminder is GONE:
  // its minute passed while nothing was running, and it will not be retried
  // today. At debug it was indistinguishable from "not yet".
  const warned = [];
  const log = { debug: () => {}, warn: (msg, fields) => warned.push({ msg, ...fields }) };
  resetSaid();

  const ctx = {
    instant: utc(2026, 8, 13, 20, 23),   // 12 hours past an 08:00 reminder
    mark: () => {},
    fetch: fakeFetch([{ status: 204 }]),
    log,
  };

  const result = await deliverAccount(account(), ctx);
  assert.deepEqual(result.skipped, { too_late: 1 });
  assert.equal(warned.length, 1);
  assert.deepEqual(
    { msg: warned[0].msg, habit: warned[0].habit, date: warned[0].date, late: warned[0].late_minutes },
    { msg: 'notify.too_late', habit: 1, date: '2026-08-13', late: 743 }
  );

  // The condition holds for the rest of the day, and a tick a minute would make
  // it 1,400 lines about one loss.
  await deliverAccount(account(), ctx);
  assert.equal(warned.length, 1, 'the same loss was reported twice');

  // Tomorrow is a different loss.
  await deliverAccount(account(), { ...ctx, instant: utc(2026, 8, 14, 20, 23) });
  assert.equal(warned.length, 2);
});

test('a reminder that WAS delivered is not reported lost for the rest of the day', async () => {
  // The window closes half an hour after the reminder, so from 08:31 every tick
  // is looking at a habit whose time has passed — including the one that went out
  // at 08:00 exactly as it should have. Asked in the wrong order, that is a
  // warning per habit per channel every single healthy day, which leaves a real
  // loss indistinguishable from the whole fleet working.
  const warned = [];
  const log = { debug: () => {}, warn: (msg, fields) => warned.push({ msg, ...fields }) };
  const ctx = {
    instant: utc(2026, 8, 13, 20, 23),
    mark: () => {},
    fetch: fakeFetch([{ status: 204 }]),
    log,
  };

  resetSaid();
  const sent = await deliverAccount(account({ alreadySent: () => true }), ctx);
  assert.deepEqual(sent.skipped, { already_sent: 1 });
  assert.deepEqual(warned, [], 'a delivered reminder was reported as lost');

  // Answered rather than sent — the phone got there first, and the day is handled
  // however it was handled.
  resetSaid();
  const done = await deliverAccount(account({ doneToday: new Set([1]) }), ctx);
  assert.deepEqual(done.skipped, { done_today: 1 });
  assert.deepEqual(warned, [], 'an answered day was reported as lost');
});

test('a destination that can never deliver says so, rather than nothing', () => {
  // The silent state: enabled, so the user believes it is on; unconfigured, so
  // `needsServerDelivery` is false and the account is skipped before anything is
  // logged above debug. Every visible surface looks right.
  resetSaid();
  const warned = [];
  const log = { warn: (msg, fields) => warned.push({ msg, ...fields }) };

  const botOnly = { notifyChannels: ['discord'], discordChannelId: '123456789012345678' };

  // A channel id with no bot token on this instance — the recommended setup,
  // missing the one credential the user cannot supply themselves.
  assert.deepEqual(warnUnreachable({ id: 7, settings: botOnly }, { log }), ['discord']);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].msg, 'notify.unreachable');
  assert.match(warned[0].reason, /DISCORD_BOT_TOKEN/);

  assert.equal(warnUnreachable({ id: 7, settings: botOnly }, { log }).length, 1);
  assert.equal(warned.length, 1, 'a configuration does not change every minute');

  // The same settings on an instance that HAS a bot are reachable.
  resetSaid();
  assert.deepEqual(warnUnreachable({ id: 7, settings: botOnly }, { log, botToken: 't' }), []);
  assert.equal(warned.length, 1, 'nothing further to say');

  // Enabled with nothing filled in at all gets the general message.
  resetSaid();
  warnUnreachable({ id: 8, settings: { notifyChannels: ['discord'] } }, { log });
  assert.match(warned[1].reason, /nothing is configured/);

  // The device channel is never this server's business, however it is set up.
  resetSaid();
  assert.deepEqual(warnUnreachable({ id: 9, settings: { notifyChannels: ['android'] } }, { log }), []);
});

test('an account with no server destination costs no requests', async () => {
  const fetch = fakeFetch([{ status: 204 }]);
  const result = await deliverAccount(
    account({ settings: { notifyChannels: ['android'] } }),
    { instant: utc(2026, 8, 13, 8, 0), mark: () => {}, fetch }
  );
  assert.deepEqual(result, { sent: 0, failed: 0, skipped: {} });
  assert.equal(fetch.calls.length, 0);
});

test('one account\'s storage failure does not stop the others', async () => {
  const errors = [];
  const result = await runTick({
    collect: () => [
      account({ id: 1, alreadySent: () => { throw new Error('database gone'); } }),
      account({ id: 2 }),
    ],
    mark: () => {},
    instant: utc(2026, 8, 13, 8, 0),
    fetch: fakeFetch([{ status: 204 }]),
    log: { warn: () => {}, error: (...a) => errors.push(a) },
  });

  assert.equal(result.sent, 1, 'the second account still got its reminder');
  assert.equal(errors.length, 1);
});

test('the watermark is per channel, so a new destination is not silenced', async () => {
  // The phone handled this habit this morning, and Discord was switched on
  // afterwards. A watermark keyed on the habit alone would swallow the first
  // Discord reminder.
  const sent = new Set(['1:android']);
  const marked = [];
  await deliverAccount(
    account({ alreadySent: (id, channel) => sent.has(`${id}:${channel}`) }),
    {
      instant: utc(2026, 8, 13, 8, 0),
      mark: (...args) => marked.push(args),
      fetch: fakeFetch([{ status: 204 }]),
    }
  );
  assert.equal(marked.length, 1);
  assert.equal(marked[0][2], 'discord');
});

test('a rate-limited send waits the requested time and retries once', async () => {
  // Five habits due at 08:00 on one webhook is enough to trip Discord's limit.
  // Leaving it to the next tick would trip it again a minute later, so the wait
  // it asks for is honoured — once.
  const fetch = fakeFetch([
    { status: 429, headers: { 'retry-after': '0.01' } },
    { status: 204 },
  ]);
  const marked = [];
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: (...args) => marked.push(args),
    fetch,
  });

  assert.deepEqual(result, { sent: 1, failed: 0, skipped: {} });
  assert.equal(fetch.calls.length, 2, 'the retry must actually be sent');
  assert.equal(marked.length, 1, 'and recorded once, not twice');
});

test('a second rate limit gives up rather than looping', async () => {
  const fetch = fakeFetch([{ status: 429, headers: { 'retry-after': '0.01' } }]);
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    fetch,
    log: { warn: () => {} },
  });

  assert.deepEqual(result, { sent: 0, failed: 1, skipped: {} });
  assert.equal(fetch.calls.length, 2);
});

/* ---------- a custom prompt per habit ---------- */

test('a custom prompt leads, and the habit name becomes the subtitle', () => {
  const message = reminderMessage(habit({ reminder_message: 'Did you exercise today?' }));
  assert.equal(message.title, 'Did you exercise today?');
  assert.equal(message.subtitle, 'Meditate',
    'a channel carrying several habits still has to say which one is asking');
  // The generated sentence is dropped: "have you done this today?" under
  // "Did you exercise today?" is the same question twice.
  assert.doesNotMatch(message.body, /have you done this today/i);
});

test('a measurable habit keeps its goal alongside a custom prompt', () => {
  const message = reminderMessage(habit({
    type: 'numerical', target_value: 8, unit: 'glasses',
    reminder_message: 'How many glasses of water so far?',
  }));
  assert.equal(message.title, 'How many glasses of water so far?');
  assert.match(message.body, /at least 8 glasses/);
});

test('no prompt behaves exactly as before', () => {
  const message = reminderMessage(habit({ reminder_message: '' }));
  assert.equal(message.title, 'Meditate');
  assert.equal(message.subtitle, '');
  assert.match(message.body, /have you done this today/i);
});

test('a blank-but-present prompt is not treated as one', () => {
  const message = reminderMessage(habit({ reminder_message: '   ' }));
  assert.equal(message.title, 'Meditate');
});

test('the Discord embed carries the prompt as its title', () => {
  const h = habit({ reminder_message: 'Did you exercise today?', description: '' });
  const payload = discordPayload({ habit: h, message: reminderMessage(h), date: '2026-08-13' });
  const [embed] = payload.embeds;
  assert.equal(embed.title, 'Did you exercise today?');
  assert.equal(embed.author.name, 'Meditate');
  assert.equal(embed.description, undefined, 'nothing to add for a yes/no habit');
});

test('a prompt at the limit is not truncated on the way out', () => {
  // LIMITS.reminderMessage is 200 and Discord's embed title cap is 256, so a
  // prompt the server accepted must always survive the send intact.
  const prompt = 'q'.repeat(200);
  const h = habit({ reminder_message: prompt });
  const payload = discordPayload({ habit: h, message: reminderMessage(h) });
  assert.equal(payload.embeds[0].title, prompt);
});
