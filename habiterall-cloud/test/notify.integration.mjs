/**
 * The reminder pipeline against a real Postgres.
 *
 * The scheduling rules are unit-tested in shared/test/notify.test.js, and the
 * RLS policy the scan depends on is attacked in tenancy.integration.mjs. What
 * this covers is the storage adapter between them: that the two-step
 * scan-then-withUser walk finds the right accounts, reads the right day, and
 * writes a watermark that stops a second tick re-sending.
 *
 * It never posts to Discord — every send goes through a fake `fetch`.
 *
 *   node test/notify.integration.mjs
 */

process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:55432/habiterall';
const ADMIN_URL = process.env.ADMIN_URL ??
  'postgres://owner:testpw@localhost:55432/habiterall';

const { withUser, pool } = await import('../src/db/pool.js');
const notifier = await import('../src/notifier.js');
const { deliverAccount } = await import('@habiterall/shared/notify-send.js');
const { handleInteraction, INTERACTION } = await import('@habiterall/shared/discord.js');

let fails = 0;
const check = (l, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' :: ' + e : ''}`);
  if (!c) fails++;
};

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/cloud-test-token';

/** A fetch stand-in, so nothing here can reach the real Discord. */
function fakeFetch(status = 204) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status, headers: { get: () => null } };
  };
  doFetch.calls = calls;
  return doFetch;
}

// 08:00 UTC on a fixed day. Reminder times are wall clock, so the instant and
// the account's zone together decide what is due.
const AT_0800_UTC = new Date(Date.UTC(2026, 7, 13, 8, 0));

const pg = (await import('pg')).default;
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();

try {
  await admin.query('DELETE FROM notify_log');
  await admin.query('DELETE FROM entries');
  await admin.query('DELETE FROM habits');
  await admin.query('DELETE FROM users');

  // Three accounts: one wants Discord, one wants only its phone, one wants
  // Discord but has not configured it. Only the first should ever be visited.
  const mkUser = async (sub, settings) => (await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, display_name, settings)
     VALUES ($1, 'https://idp', $1, $2::jsonb) RETURNING id`,
    [sub, JSON.stringify(settings)]
  )).rows[0].id;

  const wired = await mkUser('sub-wired', {
    notifyChannels: ['android', 'discord'],
    discordWebhook: WEBHOOK,
    notifyTimezone: 'UTC',
  });
  const phoneOnly = await mkUser('sub-phone', { notifyChannels: ['android'] });
  const halfDone = await mkUser('sub-half', { notifyChannels: ['discord'] });
  const traveller = await mkUser('sub-tokyo', {
    notifyChannels: ['discord'],
    discordWebhook: WEBHOOK,
    notifyTimezone: 'Asia/Tokyo',
  });

  const mkHabit = async (userId, name, time) => withUser(userId, (db) =>
    db.query(
      `INSERT INTO habits (user_id, name, type, reminder_time)
       VALUES ($1, $2, 'boolean', $3) RETURNING id`,
      [userId, name, time]
    ).then((r) => r.rows[0].id));

  const wiredHabit = await mkHabit(wired, 'Meditate', '08:00');
  await mkHabit(wired, 'No reminder', '');
  await mkHabit(phoneOnly, 'Phone only', '08:00');
  await mkHabit(halfDone, 'Unconfigured', '08:00');
  await mkHabit(traveller, 'Tokyo morning', '08:00');

  console.log('--- who gets visited ---');
  const accounts = await notifier.collect(AT_0800_UTC);
  const ids = accounts.map((a) => a.id).sort((a, b) => a - b);
  check('only accounts with a configured server destination are collected',
    JSON.stringify(ids) === JSON.stringify([wired, traveller].sort((a, b) => a - b)),
    JSON.stringify({ ids, wired, phoneOnly, halfDone, traveller }));

  const wiredAccount = accounts.find((a) => a.id === wired);
  check('only habits with a reminder time are carried',
    wiredAccount.habits.length === 1, JSON.stringify(wiredAccount.habits.map((h) => h.name)));

  console.log('--- delivery ---');
  const fetch1 = fakeFetch();
  const first = await deliverAccount(wiredAccount, {
    instant: AT_0800_UTC, mark: notifier.mark, fetch: fetch1,
  });
  check('the reminder is delivered', first.sent === 1 && first.failed === 0,
    JSON.stringify(first));
  check('to the stored webhook', fetch1.calls[0]?.url === WEBHOOK, fetch1.calls[0]?.url);
  check('naming the habit', fetch1.calls[0]?.body?.embeds?.[0]?.title === 'Meditate');

  const logged = await withUser(wired, (db) =>
    db.query('SELECT habit_id, channel, date FROM notify_log').then((r) => r.rows));
  check('the send is written to the watermark under the local date',
    logged.length === 1 && logged[0].date === '2026-08-13' &&
    logged[0].channel === 'discord' && Number(logged[0].habit_id) === Number(wiredHabit),
    JSON.stringify(logged));

  console.log('--- the next tick, a minute later ---');
  const again = (await notifier.collect(AT_0800_UTC)).find((a) => a.id === wired);
  const fetch2 = fakeFetch();
  await deliverAccount(again, {
    instant: AT_0800_UTC, mark: notifier.mark, fetch: fetch2,
  });
  check('does not send the same reminder twice', fetch2.calls.length === 0,
    `posted ${fetch2.calls.length} times`);

  console.log('--- one account\'s watermark is not another\'s ---');
  // The traveller is 08:00 in Tokyo at 23:00 UTC the day before, so at 08:00
  // UTC it is 17:00 there — nothing due, and certainly not suppressed by the
  // other account's send.
  const tokyo = (await notifier.collect(AT_0800_UTC)).find((a) => a.id === traveller);
  const fetch3 = fakeFetch();
  await deliverAccount(tokyo, {
    instant: AT_0800_UTC, mark: notifier.mark, fetch: fetch3,
  });
  check('nothing is due for the Tokyo account at 08:00 UTC', fetch3.calls.length === 0);

  const tokyoMorning = new Date(Date.UTC(2026, 7, 13, 23, 0));   // 08:00 in Tokyo
  const tokyoDue = (await notifier.collect(tokyoMorning)).find((a) => a.id === traveller);
  const fetch4 = fakeFetch();
  await deliverAccount(tokyoDue, {
    instant: tokyoMorning, mark: notifier.mark, fetch: fetch4,
  });
  check('and it is due at 23:00 UTC, which is 08:00 there', fetch4.calls.length === 1);

  const tokyoLog = await withUser(traveller, (db) =>
    db.query('SELECT date FROM notify_log').then((r) => r.rows));
  check('filed under the 14th — the traveller\'s date, not the server\'s',
    tokyoLog.length === 1 && tokyoLog[0].date === '2026-08-14', JSON.stringify(tokyoLog));

  console.log('--- already recorded today ---');
  await withUser(wired, (db) => db.query(
    `INSERT INTO entries (habit_id, user_id, date, value) VALUES ($1, $2, '2026-08-20', 2)`,
    [wiredHabit, wired]
  ));
  const doneDay = new Date(Date.UTC(2026, 7, 20, 8, 0));
  const doneAccount = (await notifier.collect(doneDay)).find((a) => a.id === wired);
  const fetch5 = fakeFetch();
  await deliverAccount(doneAccount, {
    instant: doneDay, mark: notifier.mark, fetch: fetch5,
  });
  check('a habit already ticked off is not nagged', fetch5.calls.length === 0,
    `posted ${fetch5.calls.length} times`);

  console.log('--- a blocked account is not served ---');
  await admin.query('UPDATE users SET blocked = true WHERE id = $1', [wired]);
  const afterBlock = (await notifier.collect(AT_0800_UTC)).map((a) => a.id);
  check('a suspended account gets no reminders', !afterBlock.includes(wired),
    JSON.stringify(afterBlock));

  console.log('--- the test endpoint\'s sender ---');
  const results = await notifier.sendTest(traveller, {
    notifyChannels: ['discord'], discordWebhook: WEBHOOK,
  }, { fetch: fakeFetch() });
  check('a test reports per channel', results.length === 1 && results[0].ok === true,
    JSON.stringify(results));

  const noneResults = await notifier.sendTest(phoneOnly, { notifyChannels: ['android'] },
    { fetch: fakeFetch() });
  check('and reports nothing to do when only the phone is chosen',
    noneResults.length === 0, JSON.stringify(noneResults));

  /* ---------- bot mode ---------- */

  const BOT_CHANNEL = '123456789012345678';
  const OTHER_CHANNEL = '223456789012345678';
  await admin.query(
    `UPDATE users SET blocked = false,
       settings = settings || $2::jsonb WHERE id = $1`,
    [wired, JSON.stringify({ discordChannelId: BOT_CHANNEL })]
  );
  await admin.query(
    `UPDATE users SET settings = settings || $2::jsonb WHERE id = $1`,
    [traveller, JSON.stringify({ discordChannelId: OTHER_CHANNEL })]
  );

  console.log('--- a bot posts buttons where a webhook cannot ---');
  const botFetch = fakeFetch();
  const botAccount = { id: wired, settings: {
    notifyChannels: ['discord'],
    discordChannelId: BOT_CHANNEL,
    notifyTimezone: 'UTC',
    // The account's own setting decides whether Skip is one of the answers, so
    // the channel offers what the grid does. Without it there are two.
    skipDays: true,
  }, habits: [{
    id: wiredHabit, name: 'Meditate', type: 'boolean', unit: '', color: '#3b82f6',
    target_value: 0, target_type: 'at_least', reminder_time: '08:00',
    reminder_message: 'Did you exercise today?', archived: false, description: '',
  }], doneToday: new Set(), alreadySent: () => false };

  // A real today, in UTC: the button handler refuses a future date (rightly),
  // so a fixture day would only ever test that guard.
  const day = new Date().toISOString().slice(0, 10);
  const [yy, mm, dd] = day.split('-').map(Number);

  const botResult = await deliverAccount(botAccount, {
    instant: new Date(Date.UTC(yy, mm - 1, dd, 8, 0)),
    mark: async () => {},
    fetch: botFetch,
    botToken: 'test-bot-token',
  });
  check('the reminder goes out as a bot message', botResult.sent === 1, JSON.stringify(botResult));
  check('to the channels endpoint, not a webhook',
    botFetch.calls[0]?.url === `https://discord.com/api/v10/channels/${BOT_CHANNEL}/messages`,
    botFetch.calls[0]?.url);
  check('carrying buttons',
    botFetch.calls[0]?.body?.components?.[0]?.components?.length === 3,
    JSON.stringify(botFetch.calls[0]?.body?.components));
  check('and the habit\'s own prompt',
    botFetch.calls[0]?.body?.embeds?.[0]?.title === 'Did you exercise today?');

  // The same account with skips switched off gets Yes / No and nothing else.
  const noSkipFetch = fakeFetch();
  await deliverAccount(
    { ...botAccount, settings: { ...botAccount.settings, skipDays: false } },
    {
      instant: new Date(Date.UTC(yy, mm - 1, dd, 8, 0)),
      mark: async () => {},
      fetch: noSkipFetch,
      botToken: 'test-bot-token',
    }
  );
  check('and no Skip button when the account does not use skip days',
    (noSkipFetch.calls[0]?.body?.components?.[0]?.components ?? [])
      .every((b) => b.label !== 'Skip'),
    JSON.stringify(noSkipFetch.calls[0]?.body?.components));

  /* ---------- a failure the user can see ---------- */
  //
  // A permanent failure is recorded as sent and logged at warn, which is right:
  // a 404 answers 404 forever. What was wrong is that the log was the ONLY
  // surface — and on a shared instance it is the one surface the person it
  // concerns cannot read, while the operator has no reason to be reading one
  // account's warnings. Per user, and scoped by RLS like everything else here.

  console.log('--- a delivery failure is reported to the account it happened to ---');
  await deliverAccount(botAccount, {
    instant: new Date(Date.UTC(yy, mm - 1, dd, 8, 0)),
    mark: async () => {},
    recordOutcome: notifier.recordOutcome,
    fetch: fakeFetch(404),
    botToken: 'test-bot-token',
    log: { warn: () => {}, debug: () => {} },
  });

  const reported = await notifier.deliveryStatus(wired);
  check('a permanent failure is stored against the account',
    reported[0]?.channel === 'discord' && reported[0]?.ok === false
      && reported[0]?.permanent === true,
    JSON.stringify(reported));
  check('carrying the sender\'s own words rather than a status code',
    /bot cannot post|invited/i.test(reported[0]?.error ?? ''), reported[0]?.error);

  // The whole point of the RLS on this table: it is a report about ONE account.
  // The traveller has a row of its own from the sends above, so the check is
  // that it holds the traveller's own outcome and nothing of the failure that
  // just happened to somebody else.
  const otherSees = await notifier.deliveryStatus(traveller);
  check('and another account is told about its own deliveries, not this one\'s',
    otherSees.every((s) => s.ok === true && !/bot cannot post/i.test(s.error ?? '')),
    JSON.stringify(otherSees));

  // A success clears it, which is what makes the settings dialog's notice go
  // away without the user having to do anything.
  await deliverAccount(
    { ...botAccount, delivered: { discord: false } },
    {
      instant: new Date(Date.UTC(yy, mm - 1, dd, 8, 0)),
      mark: async () => {},
      recordOutcome: notifier.recordOutcome,
      fetch: fakeFetch(),
      botToken: 'test-bot-token',
      log: { warn: () => {}, debug: () => {} },
    }
  );
  const afterFix = await notifier.deliveryStatus(wired);
  check('a success clears the failure', afterFix[0]?.ok === true,
    JSON.stringify(afterFix));

  /* ---------- answering from a button ---------- */

  console.log('--- a click writes to the right account ---');
  const adapter = notifier.interactionAdapter();
  const press = (channelId, customId, extra = {}) => {
    const sent = [];
    return handleInteraction({
      id: 'i1', token: 'tok', type: INTERACTION.COMPONENT,
      channel_id: channelId,
      member: { user: { id: '999999999999999999' } },
      message: { embeds: [{ title: 'Did you exercise today?' }] },
      data: { custom_id: customId },
      ...extra,
    }, { ...adapter, respond: async (i, r) => { sent.push(r); } }).then(() => sent);
  };

  const yes = await press(BOT_CHANNEL, `hab|${wiredHabit}|${day}|yes`);
  const entries = await withUser(wired, (db) =>
    db.query(`SELECT to_char(date,'YYYY-MM-DD') AS date, value, status
                FROM entries WHERE habit_id = $1 AND date = $2`, [wiredHabit, day])
      .then((r) => r.rows));
  check('pressing Yes records a completion for that user',
    entries.length === 1 && Number(entries[0].value) === 2, JSON.stringify(entries));
  check('and the message is updated in place', yes.at(-1)?.type === 7, JSON.stringify(yes.at(-1)));

  // The channel is what decides whose data is written. A habit id from another
  // account is looked up inside the resolved account, so it simply is not there.
  const crossUser = await press(OTHER_CHANNEL, `hab|${wiredHabit}|${day}|yes`);
  check('a habit id from another account cannot be written through a channel',
    /no longer exists/i.test(crossUser.at(-1)?.data?.content ?? ''),
    JSON.stringify(crossUser.at(-1)));
  const stillOne = await withUser(traveller, (db) =>
    db.query(`SELECT COUNT(*)::int c FROM entries WHERE habit_id = $1`, [wiredHabit])
      .then((r) => r.rows[0].c));
  check('and nothing landed in the other account', stillOne === 0, String(stillOne));

  const unknown = await press('999999999999999999', `hab|${wiredHabit}|${day}|yes`);
  check('a channel no account claims is refused',
    unknown.at(-1)?.data?.flags === 64, JSON.stringify(unknown.at(-1)));

  // A user id set on the account narrows who may answer.
  await admin.query(
    `UPDATE users SET settings = settings || $2::jsonb WHERE id = $1`,
    [wired, JSON.stringify({ discordUserId: '111111111111111111' })]
  );
  const impostor = await press(BOT_CHANNEL, `hab|${wiredHabit}|${day}|skip`);
  check('with a Discord user set, someone else\'s click is refused',
    /not your habits/i.test(impostor.at(-1)?.data?.content ?? ''), JSON.stringify(impostor.at(-1)));
  const unchanged = await withUser(wired, (db) =>
    db.query(`SELECT status FROM entries WHERE habit_id = $1 AND date = $2`, [wiredHabit, day])
      .then((r) => r.rows[0]?.status));
  check('and the entry is untouched', unchanged === '', JSON.stringify(unchanged));

  // #221 gave an avoided habit (show_as: 'avoid' + at_most + numerical) Clean /
  // Slipped buttons carrying the ordinary yes/no actions, but `record()` mapped
  // them with the fixed boolean encoding — inverted for this habit shape, and
  // invisible in the reply text, which says "Clean" either way. This is the
  // "output that reached the platform" half: a real press, through the real
  // adapter and `withUser`, read back from Postgres. Assert the STORED VALUE,
  // never the label. Discord user restriction is dropped first, or this press
  // would be refused for the same reason the impostor one above was.
  await admin.query(
    `UPDATE users SET settings = settings - 'discordUserId' WHERE id = $1`, [wired]
  );
  const avoidedHabit = await withUser(wired, (db) =>
    db.query(
      `INSERT INTO habits (user_id, name, type, target_type, target_value, show_as)
       VALUES ($1, 'Smoking', 'numerical', 'at_most', 0, 'avoid') RETURNING id`,
      [wired]
    ).then((r) => r.rows[0].id));

  await press(BOT_CHANNEL, `hab|${avoidedHabit}|${day}|yes`);
  const avoidedAfterYes = await withUser(wired, (db) =>
    db.query(`SELECT value, status FROM entries WHERE habit_id = $1 AND date = $2`,
      [avoidedHabit, day]).then((r) => r.rows[0]));
  check('pressing Clean (yes) on an avoided habit stores 0, not YES',
    avoidedAfterYes?.status === '' && Number(avoidedAfterYes?.value) === 0,
    JSON.stringify(avoidedAfterYes));

  await press(BOT_CHANNEL, `hab|${avoidedHabit}|${day}|no`);
  const avoidedAfterNo = await withUser(wired, (db) =>
    db.query(`SELECT value, status FROM entries WHERE habit_id = $1 AND date = $2`,
      [avoidedHabit, day]).then((r) => r.rows[0]));
  check('pressing Slipped (no) on an avoided habit stores target+1 (1), not UNSET',
    avoidedAfterNo?.status === '' && Number(avoidedAfterNo?.value) === 1,
    JSON.stringify(avoidedAfterNo));

  /* ---------- answering from an ntfy button: the tenancy question ---------- */
  //
  // ntfy's button carries no session and no channel to resolve an account
  // from — the code IS the account, over an HMAC. The habit id riding beside
  // it must never be trusted on its own: mint a code for `wired` naming
  // `traveller`'s own habit and prove the write is scoped by `withUser`, not
  // by the id in the payload. The general shape of the route (HTTP mounting,
  // Origin handling, the inline limiter) is covered against a real server in
  // ntfy-answer.integration.mjs; this is the one thing only Postgres can
  // prove, so it stays beside the rest of this file's `withUser` checks.
  console.log('--- ntfy: a code minted for one account cannot reach another\'s habit ---');
  const { handleNtfyAnswer, signNtfyAnswer } = await import('@habiterall/shared/ntfy-answer.js');
  process.env.SESSION_SECRET ??= 'cloud-notify-integration-secret';
  const ntfyAdapter = notifier.ntfyAnswerAdapter();

  const travellerSecretHabit = await mkHabit(traveller, 'Tokyo Secret Habit', '');
  const tenancyCode = signNtfyAnswer({
    secret: process.env.SESSION_SECRET, account: String(wired),
    habitId: travellerSecretHabit, date: day, action: 'yes',
  });
  const tenancyResult = await handleNtfyAnswer(tenancyCode,
    { ...ntfyAdapter, log: { error: () => {} } });
  check('a valid code naming another account\'s habit id is refused, not honoured',
    tenancyResult.status === 400 && /no longer exists/i.test(tenancyResult.error ?? ''),
    JSON.stringify(tenancyResult));

  const travellerUntouched = await withUser(traveller, (db) =>
    db.query(`SELECT COUNT(*)::int c FROM entries WHERE habit_id = $1 AND date = $2`,
      [travellerSecretHabit, day]).then((r) => r.rows[0].c));
  check('the traveller\'s habit is untouched', travellerUntouched === 0,
    `entries=${travellerUntouched}`);

  const wiredGainedNothing = await withUser(wired, (db) =>
    db.query(`SELECT COUNT(*)::int c FROM entries WHERE habit_id = $1`, [travellerSecretHabit])
      .then((r) => r.rows[0].c));
  check('and wired gained nothing either — RLS hides the row from that account entirely',
    wiredGainedNothing === 0, `entries=${wiredGainedNothing}`);

  /* ---------- one account follows its device, another does not ---------- */
  //
  // The multi-tenant half of the same rule: two accounts, one on `auto` and one
  // that named a zone, must resolve independently — the same property the
  // watermark check above proves for the calendar day.
  console.log('--- whose clock ---');
  const follower = await mkUser('sub-follow', {
    notifyChannels: ['discord'], discordWebhook: WEBHOOK, notifyTimezone: 'auto',
  });
  const pinned = await mkUser('sub-pinned', {
    notifyChannels: ['discord'], discordWebhook: WEBHOOK, notifyTimezone: 'UTC',
  });
  await mkHabit(follower, 'Follows the phone', '08:00');
  await mkHabit(pinned, 'Stays on UTC', '08:00');

  // Both phones report Tokyo. Only the account on `auto` should move.
  await admin.query(
    `UPDATE users SET device_time_zone = 'Asia/Tokyo' WHERE id = ANY($1::bigint[])`,
    [[follower, pinned]]);

  const tokyoMorningAgain = new Date(Date.UTC(2026, 7, 13, 23, 0)); // 08:00 Tokyo
  const atTokyo = await notifier.collect(tokyoMorningAgain);
  const followerDue = await deliverAccount(atTokyo.find((a) => a.id === follower),
    { instant: tokyoMorningAgain, mark: notifier.mark, fetch: fakeFetch() });
  check('an account on auto is due at 08:00 on its phone\'s clock',
    followerDue.sent === 1, JSON.stringify(followerDue));

  const pinnedAtTokyo = await deliverAccount(atTokyo.find((a) => a.id === pinned),
    { instant: tokyoMorningAgain, mark: notifier.mark, fetch: fakeFetch() });
  check('an account that named UTC is not moved by its phone',
    pinnedAtTokyo.sent === 0, JSON.stringify(pinnedAtTokyo));

  const atUtc = await notifier.collect(AT_0800_UTC);
  const pinnedDue = await deliverAccount(atUtc.find((a) => a.id === pinned),
    { instant: AT_0800_UTC, mark: notifier.mark, fetch: fakeFetch() });
  check('...and is due at 08:00 UTC instead', pinnedDue.sent === 1,
    JSON.stringify(pinnedDue));

  /* ---------- one account's read is not the whole tick ---------- */
  //
  // `collect` runs one `withUser` transaction per account, fanned out through
  // `mapWithLimit` rather than awaited one at a time, and that whole fan-out
  // is awaited in full before `runTick`'s own per-account try even starts. So
  // a pool timeout on account 3 of 400 used to throw out of here and discard
  // every account already collected along with every one behind it, for the
  // whole minute — the isolating `.catch` inside `collect`'s mapped function
  // is what stops that now, per account, exactly as it did in the old
  // sequential loop.
  //
  // The seam is `pool.connect`, which is a prototype method — assigning to the
  // instance shadows it, and the suite already imports `pool` to close it.
  // `collect` opens one connection for the notifier-scope scan; the fan-out's
  // workers then each call `withUser` — and, crucially, do nothing async
  // before that call — so their first `pool.connect()` calls land in item
  // order, back to back, before any of them can resolve. #2 is therefore
  // still deterministically the first account, whatever the derived
  // concurrency limit turns out to be.
  console.log('--- one account\'s read failure ---');
  // Relative to a clean pass, not a hardcoded count: this suite grows accounts
  // as it goes, and an absolute number here breaks whenever a section above
  // adds one — which is a test failing for a reason that is not the code's.
  const healthy = (await notifier.collect(AT_0800_UTC)).length;
  const realConnect = pool.connect.bind(pool);
  let connects = 0;
  pool.connect = (...args) => (++connects === 2
    ? Promise.reject(Object.assign(
      new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' }))
    : realConnect(...args));
  // Caught rather than allowed to escape: without the guard `collect` REJECTS,
  // and an unhandled rejection here would take the suite down with a stack
  // trace instead of reporting a failed check.
  let survived = null;
  let threw = null;
  try {
    survived = await notifier.collect(AT_0800_UTC);
  } catch (err) {
    threw = err;
  } finally {
    pool.connect = realConnect;
  }
  check('one account\'s read failure does not discard the whole tick',
    !threw && survived?.length === healthy - 1,
    threw ? `collect threw: ${threw.message}`
      : JSON.stringify({ got: survived.map((a) => a.id), healthy }));
  check('and the survivors are whole accounts, not partial ones',
    (survived ?? []).length > 0
      && survived.every((a) => a.id !== undefined && a.habits.length > 0),
    JSON.stringify((survived ?? []).map((a) => ({ id: a.id, habits: a.habits.length }))));

  /* ---------- a throw ahead of `withUser` is caught, logged, and cannot leak an Error into the result ---------- */
  //
  // Hardening, not a live bug — see the comment above the `try` in `collect`.
  // Nobody has named an input that makes `warnUnreachable`, `needsServerDelivery`,
  // `resolveTimeZone` or `zonedClock` throw (`formatterFor` swallows a bad zone
  // rather than throwing one), so both throws below are INJECTED — through
  // `log`, which is a plain mutable object and the one seam here that is not a
  // frozen ES module binding. Nothing about this proves either call site is
  // reachable this way today; it proves the two guards hold if one ever is.
  console.log('--- a throw ahead of withUser is caught and logged; an Error that still escapes is filtered anyway ---');

  const { log } = await import('@habiterall/shared/log.js');
  const realWarn = log.warn;
  const realError = log.error;

  // First half: the widened `try` catches a throw from `warnUnreachable` (the
  // first of the four pre-`withUser` calls) and logs it as
  // `notify.account_failed`, exactly as a `withUser` rejection already did.
  const caught = await mkUser('sub-throw-caught', { notifyChannels: ['discord'] }); // unreachable: no webhook
  await mkHabit(caught, 'Caught habit', '08:00');

  const errors = [];
  log.error = (...args) => { errors.push(args); return realError(...args); };
  log.warn = (...args) => {
    const [event, detail] = args;
    if (event === 'notify.unreachable' && detail?.user === caught) {
      throw new Error('synthetic: a throw ahead of withUser');
    }
    return realWarn(...args);
  };

  let caughtResult = null;
  let caughtThrew = null;
  try {
    caughtResult = await notifier.collect(AT_0800_UTC);
  } catch (err) {
    caughtThrew = err;
  } finally {
    log.warn = realWarn;
    log.error = realError;
  }

  check('collect() does not reject over one account\'s pre-withUser throw',
    !caughtThrew, caughtThrew ? caughtThrew.message : '');
  check('the account that threw ahead of withUser is dropped, not carried forward',
    !!caughtResult && !caughtResult.some((a) => a?.id === caught),
    JSON.stringify((caughtResult ?? []).map((a) => a?.id)));
  check('every OTHER account collected is still whole',
    !!caughtResult && caughtResult.length > 0
      && caughtResult.every((a) => a?.id !== undefined && Array.isArray(a?.habits) && a.habits.length > 0),
    JSON.stringify((caughtResult ?? []).map((a) => a?.id)));
  check('that failure is LOGGED as notify.account_failed, not silent',
    errors.some(([event, fields]) => event === 'notify.account_failed' && fields?.user === caught),
    JSON.stringify(errors));

  // Second half: the structural filter — `results.filter((a) => a && !(a
  // instanceof Error))` — has to hold even when something escapes the widened
  // catch too, which is forced here by making the catch's OWN `log.error` call
  // throw a second time. That is exactly the shape `mapWithLimit`'s own
  // backstop exists for (a worker function that lets a rejection escape), and
  // it is what distinguishes the structural filter from `.filter(Boolean)`:
  // an escaped `Error` is truthy, so only the `instanceof Error` half drops it.
  const escaped = await mkUser('sub-throw-escaped', { notifyChannels: ['discord'] }); // unreachable: no webhook
  await mkHabit(escaped, 'Escaped habit', '08:00');

  log.warn = (...args) => {
    const [event, detail] = args;
    if (event === 'notify.unreachable' && detail?.user === escaped) {
      log.error = () => { throw new Error('synthetic: escapes the catch too'); };
      throw new Error('synthetic: a throw ahead of withUser');
    }
    return realWarn(...args);
  };

  let escapedResult = null;
  let escapedThrew = null;
  try {
    escapedResult = await notifier.collect(AT_0800_UTC);
  } catch (err) {
    escapedThrew = err;
  } finally {
    log.warn = realWarn;
    log.error = realError;
  }

  check('collect() does not reject even when the catch\'s own logging throws',
    !escapedThrew, escapedThrew ? escapedThrew.message : '');
  check('no Error instance reaches the caller, however it escaped',
    !!escapedResult && escapedResult.every((a) => a && !(a instanceof Error)),
    JSON.stringify((escapedResult ?? []).map((a) => (a instanceof Error ? `Error:${a.message}` : a?.id))));
  check('the account behind the double failure is absent rather than a fake account',
    !!escapedResult && !escapedResult.some((a) => a?.id === escaped),
    JSON.stringify((escapedResult ?? []).map((a) => a?.id)));
  check('every OTHER account collected is still whole, structural filter or not',
    !!escapedResult && escapedResult.length > 0
      && escapedResult.every((a) => a?.id !== undefined && Array.isArray(a?.habits) && a.habits.length > 0),
    JSON.stringify((escapedResult ?? []).map((a) => a?.id)));

  /* ---------- collect fans out past the concurrency limit ---------- */
  //
  // The section above proves isolation with whatever accounts earlier
  // sections happened to leave configured, which has never been more than a
  // handful — fewer than `COLLECT_CONCURRENCY` can ever be. That cannot tell
  // a bounded fan-out from an accident: with N <= the limit, `mapWithLimit`
  // starts one worker per item and the loop below would pass even if the fan
  // out were, say, unlimited. So this blocks every account created so far and
  // creates more than the limit's own ceiling of 6, forcing at least one
  // worker to loop back for a second item.
  console.log('--- collect fans out across accounts, and isolation holds past the limit ---');
  await admin.query('UPDATE users SET blocked = true');

  const CONCURRENCY_ACCOUNTS = 8; // > 6, the highest COLLECT_CONCURRENCY can ever be
  const concurrencyIds = [];
  for (let i = 0; i < CONCURRENCY_ACCOUNTS; i++) {
    const id = await mkUser(`sub-conc-${i}`, {
      notifyChannels: ['discord'], discordWebhook: WEBHOOK, notifyTimezone: 'UTC',
    });
    await mkHabit(id, `Concurrency habit ${i}`, '08:00');
    concurrencyIds.push(id);
  }
  concurrencyIds.sort((a, b) => a - b);

  const wholeSet = await notifier.collect(AT_0800_UTC);
  check('every account due is collected, not merely as many as fit in one wave',
    wholeSet.length === CONCURRENCY_ACCOUNTS
      && concurrencyIds.every((id) => wholeSet.some((a) => a.id === id)),
    JSON.stringify(wholeSet.map((a) => a.id)));

  // As above: the scan is connect #1, and — because nothing async happens
  // before a worker's own `withUser` call — the first two workers' connects
  // land at #2 and #3 in that order however many workers `COLLECT_CONCURRENCY`
  // starts. Failing #3 fails the SECOND smallest id, well inside the first
  // wave whether the derived limit is 1 or 6, so this does not depend on how
  // the remaining accounts get divided up once real query latency is in play.
  const realConnect2 = pool.connect.bind(pool);
  let concurrencyConnects = 0;
  pool.connect = (...args) => (++concurrencyConnects === 3
    ? Promise.reject(Object.assign(
      new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' }))
    : realConnect2(...args));

  let concurrencySurvived = null;
  let concurrencyThrew = null;
  try {
    concurrencySurvived = await notifier.collect(AT_0800_UTC);
  } catch (err) {
    concurrencyThrew = err;
  } finally {
    pool.connect = realConnect2;
  }

  // Every other account was blocked above, so `concurrencySurvived` is not
  // filtered down to `concurrencyIds` here — an escaped Error object has no
  // `.id`, and filtering it out by "is this one of ours" would silently drop
  // exactly the leak this is meant to catch, leaving the count and the
  // "whole account" check both looking correct on a build that lets one
  // through.
  const failedId = concurrencyIds[1];
  const concurrencySurvivors = concurrencySurvived ?? [];
  check('one account failing to read past the concurrency limit does not shrink the rest',
    !concurrencyThrew && concurrencySurvivors.length === CONCURRENCY_ACCOUNTS - 1,
    concurrencyThrew ? `collect threw: ${concurrencyThrew.message}`
      : JSON.stringify({ survivorIds: concurrencySurvivors.map((a) => a?.id), failedId }));
  check('the missing one is the account that actually failed, not an arbitrary one',
    !concurrencySurvivors.some((a) => a?.id === failedId),
    JSON.stringify(concurrencySurvivors.map((a) => a?.id)));
  check('and every survivor is a whole account rather than an escaped Error object',
    concurrencySurvivors.length > 0
      && concurrencySurvivors.every((a) =>
        a?.id !== undefined && Array.isArray(a?.habits) && a.habits.length > 0),
    JSON.stringify(concurrencySurvivors.map((a) => ({ id: a?.id, habits: a?.habits?.length }))));

  console.log(fails === 0 ? '\nALL CLOUD NOTIFY CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
} finally {
  await admin.end();
  await pool.end();
}

process.exit(fails ? 1 : 0);
