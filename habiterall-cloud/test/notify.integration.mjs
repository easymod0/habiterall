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
  // `collect` runs one `withUser` transaction per account, and the loop sits
  // OUTSIDE `runTick`'s per-account try because `collect` is awaited before it.
  // So a pool timeout on account 3 of 400 used to throw out of here and discard
  // every account already collected along with every one behind it, for the
  // whole minute.
  //
  // The seam is `pool.connect`, which is a prototype method — assigning to the
  // instance shadows it, and the suite already imports `pool` to close it.
  // `collect` opens one connection for the notifier-scope scan and then one per
  // account, sequentially, so #2 is the first account.
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

  console.log(fails === 0 ? '\nALL CLOUD NOTIFY CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
} finally {
  await admin.end();
  await pool.end();
}

process.exit(fails ? 1 : 0);
