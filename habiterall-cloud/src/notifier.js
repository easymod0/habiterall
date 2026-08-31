/**
 * Server-sent reminders, cloud edition.
 *
 * The scheduling lives in @habiterall/shared/notify.js and the delivery in
 * notify-send.js; this file is the storage adapter, and the place where the
 * tenancy rules for a job that has no request behind it are spelled out.
 *
 * Two-step by design:
 *
 *   1. one read-only scan over `users` (see `withNotifierScope`) to find the
 *      accounts with a server-delivered destination configured, and
 *   2. per account, an ordinary `withUser` transaction for the habits, the
 *      day's entries, and the watermark.
 *
 * Step 2 is what keeps RLS meaningful here: the reminders themselves are read
 * exactly the way a request would read them, so a mistake in this file fails
 * closed like any other.
 *
 * The Android channel is absent on purpose — the phone arms its own alarms
 * from `habits.reminder_time` and needs no server at all.
 */

import { forgetAccount } from './cache.js';
import { pool, withNotifierScope, withUser, withUserWrite } from './db/pool.js';
import {
  answeredIds, answerText, CHANNELS, channelInteractive, needsServerDelivery,
  serverChannels, resolveTimeZone,
  zonedClock,
} from '@habiterall/shared/notify.js';
import {
  mapWithLimit, notifierConfig, sendToChannel, startNotifier, warnUnreachable,
} from '@habiterall/shared/notify-send.js';
import { handleInteraction } from '@habiterall/shared/discord.js';
import { connectGateway } from '@habiterall/shared/discord-gateway.js';
import { UNSET, YES, SKIP } from '@habiterall/shared/constants.js';
import { answerBody, entryWrite, parseEntry } from '@habiterall/shared/validate.js';
import { signNtfyAnswer } from '@habiterall/shared/ntfy-answer.js';
import { log } from '@habiterall/shared/log.js';

/** Channels this server delivers itself; the scan filters on these. */
const SERVER_CHANNEL_IDS = Object.entries(CHANNELS)
  .filter(([, c]) => c.delivery === 'server')
  .map(([id]) => id);

/** Rows older than this are only a historical "did we?"; drop them. */
const KEEP_LOG_DAYS = 45;

/**
 * Never visit more accounts in one tick than this.
 *
 * A tick is a minute long and each account can cost a webhook round trip, so
 * an unbounded scan on a large instance would overlap its successor — which
 * `startNotifier` then skips, starving whoever sorted last. The bound makes
 * that failure visible in the log instead of silent, and it is far above any
 * plausible self-hosted deployment.
 */
const MAX_ACCOUNTS_PER_TICK = Number(process.env.NOTIFY_MAX_ACCOUNTS) || 500;

/**
 * How many accounts `collect` reads concurrently.
 *
 * Derived from the pool's own configured max (`pool.options.max` — the same
 * number `poolGauge()` reports as `pg_max`) rather than a literal: a busy
 * tick still has to leave connections for live requests, so this takes
 * roughly half of it, floored at 1 (an operator who set the pool down to 1
 * still gets a tick that completes) and capped at 6 (an operator who raised
 * the pool to serve more traffic should not hand the notifier proportionally
 * more of it — each account here is a transaction of four queries, and past
 * a point that competes with `/overview` rather than shortening a slow tick).
 * A hardcoded number would silently starve the API the moment an operator set
 * `PG_POOL_MAX` below what it assumed.
 */
export const COLLECT_CONCURRENCY =
  Math.max(1, Math.min(6, Math.floor((pool.options?.max ?? 10) / 2)));

/**
 * How many accounts `runTick` (`@habiterall/shared/notify-send.js`) delivers
 * to at once, on this edition.
 *
 * `deliverAccount` calls `mark` and `recordOutcome`, above, after every send,
 * and both run as the account's own `withUser` transaction — a pool checkout
 * each. `notify-send.js`'s own `DELIVERY_CONCURRENCY` comment is where that is
 * explained at length; what belongs here is only the arithmetic, derived from
 * `pool.options.max` the same way `COLLECT_CONCURRENCY` is, for the same
 * reason: a hardcoded number silently starves the API the moment an operator
 * lowers `PG_POOL_MAX` below what it assumed.
 *
 * Not summed with `COLLECT_CONCURRENCY` — `collect()` runs to completion
 * before any delivery starts (see `start()`, below), so a tick never holds
 * checkouts for both at once, and each only has to fit the pool ON ITS OWN.
 * Same floor and the same half-of-the-pool fraction as `COLLECT_CONCURRENCY`,
 * but capped at 8 rather than 6: a delivery worker holds its checkout for the
 * length of one `mark`/`recordOutcome` write, not for a whole four-query read
 * held across the account's collect, so it costs the pool less per worker for
 * the same concurrency — and 8 is the number this replaces, so an operator on
 * the default pool sees the derivation only shrink the number when the pool
 * itself is the constraint, never raise it past what always ran.
 */
export const DELIVERY_CONCURRENCY =
  Math.max(1, Math.min(8, Math.floor((pool.options?.max ?? 10) / 2)));

/**
 * The accounts with something for this server to deliver.
 *
 * `?|` asks whether the JSONB array holds any of these ids. An account that
 * has never touched the setting has no `notifyChannels` key at all and is
 * correctly skipped: the default is the on-device channel, which needs nothing
 * from here.
 */
async function candidates() {
  const { rows } = await withNotifierScope((db) =>
    db.query(
      `SELECT id, settings, device_time_zone FROM users
        WHERE blocked = false
          AND settings -> 'notifyChannels' ?| $1::text[]
        ORDER BY id
        LIMIT $2`,
      [SERVER_CHANNEL_IDS, MAX_ACCOUNTS_PER_TICK + 1]
    )
  );

  if (rows.length > MAX_ACCOUNTS_PER_TICK) {
    // Whoever sorts last is silently starved, so this must be loud enough to
    // alert on rather than a line nobody reads.
    log.warn('notify.scan_truncated', {
      limit: MAX_ACCOUNTS_PER_TICK,
      found_at_least: rows.length,
    });
  }
  return rows.slice(0, MAX_ACCOUNTS_PER_TICK);
}

/**
 * Everything one tick needs, read up front so no storage is touched while a
 * webhook is in flight.
 *
 * @param {Date|number} instant
 */
export async function collect(instant) {
  const { botToken } = notifierConfig(process.env);

  // `mapWithLimit` rather than the plain for-loop this used to be: the scan
  // above already returned every candidate, so nothing here decides who is
  // visited, only how many are read at once. `collect` is still awaited in
  // full before any webhook goes out (`start()`, below) — concurrency INSIDE
  // this read is the whole change; interleaving it with delivery is not.
  const results = await mapWithLimit(await candidates(), COLLECT_CONCURRENCY, async (row) => {
    // Per account, because one account's read must not abandon the tick — a
    // pool timeout on account 3 of 400 used to throw out of the old for-loop
    // and discard every account already collected along with every one behind
    // it, for the whole minute. It is the same shape as the watermark failure
    // inside `deliverAccount`, one level up and with a wider blast radius, and
    // it surfaced only as `startNotifier`'s printf line.
    //
    // This catch has to stay HERE, inside the function `mapWithLimit` calls
    // per item, and not be moved to wrap the `mapWithLimit(...)` call itself.
    // `mapWithLimit` has its own catch, but that one is only a backstop for a
    // worker function that lets a rejection escape — it records the error
    // itself at `results[index]` rather than a logged, named `null`, and an
    // `Error` there is truthy: `.filter(Boolean)` used to keep it and hand
    // `runTick` a fake account, where `account.settings ?? {}` reads as no
    // channels configured — healthy, with nothing due, and no log line at
    // all. `results.filter((a) => a && !(a instanceof Error))`, below, is the
    // other half of that guarantee, so it holds whichever way this function
    // exits.
    //
    // It wraps the WHOLE body below, not only the `withUser` call — this is
    // hardening rather than a known defect. Nobody has named an input that
    // makes `warnUnreachable`, `needsServerDelivery`, `resolveTimeZone` or
    // `zonedClock` throw (`formatterFor` swallows a bad zone rather than
    // throwing one), but the guarantee this catch makes should be about the
    // FUNCTION, not about which line in it happens to touch the database
    // today, and the four calls ahead of `withUser` cost nothing extra to
    // cover.
    try {
      const settings = row.settings ?? {};
      // The scan's SQL predicate is deliberately loose (it cannot tell whether a
      // webhook URL or a channel id is actually filled in); this is the real test,
      // and it needs to know whether this instance has a bot at all.
      //
      // A user who fails it is skipped in silence, which is why the warning comes
      // first — on a shared instance the operator is the only one who can see the
      // log, and the only one who can add a bot token.
      warnUnreachable({ id: row.id, settings }, { botToken, log });
      if (!needsServerDelivery(settings, { bot: !!botToken })) {
        return null;
      }

      // Whose clock: the zone the account NAMED, else the one its last client
      // reported, else this server's. `resolveTimeZone` is the only place that
      // precedence exists, so the tick and the Discord handler cannot drift.
      const timeZone = resolveTimeZone(settings, String(row.device_time_zone ?? ''));
      const clock = zonedClock(instant, timeZone);

      return await withUser(row.id, async (db) => {
        const { rows: habits } = await db.query(
          `SELECT * FROM habits
            WHERE archived = false AND reminder_time <> ''
            ORDER BY position, id`
        );
        if (!habits.length) return null;

        const { rows: entries } = await db.query(
          `SELECT habit_id, value, status FROM entries WHERE date = $1`,
          [clock.date]
        );
        const { rows: sent } = await db.query(
          `SELECT habit_id, channel FROM notify_log WHERE date = $1`,
          [clock.date]
        );
        const { rows: status } = await db.query(
          `SELECT channel, ok, status, error, permanent FROM notify_status`
        );

        const already = new Set(sent.map((s) => `${s.habit_id}:${s.channel}`));
        return {
          id: row.id,
          settings,
          // Resolved once and carried, so `deliverAccount` cannot decide it again.
          timeZone,
          habits,
          doneToday: answeredIds(habits, entries),
          alreadySent: (habitId, channel) => already.has(`${habitId}:${channel}`),
          // Read here rather than at write time so `recordOutcome` is only called
          // when the news is new — see `noteOutcome` in notify-send.js, which
          // needs the stored REASON and not merely whether it worked.
          delivered: Object.fromEntries(status.map((s) => [s.channel, {
            ok: s.ok === true,
            status: s.status ?? undefined,
            error: String(s.error ?? ''),
            permanent: s.permanent === true,
          }])),
        };
      });
    } catch (err) {
      // Named and counted rather than fatal. `notify.account_failed` is what
      // `runTick` logs for the delivery half of the same problem, so the two
      // read alike in a log.
      log.error?.('notify.account_failed', { user: row.id, phase: 'collect' }, err);
      return null;
    }
  });

  // Structural, not merely truthy: `mapWithLimit`'s own backstop stores an
  // `Error` for any worker function that lets a rejection escape, and an
  // `Error` is truthy — `.filter(Boolean)` kept it and handed `runTick` a fake
  // account. The cast is for `tsc`, which cannot see `instanceof Error` as
  // narrowing an inline predicate the way it does the `Boolean` special case.
  return /** @type {import('@habiterall/shared/notify-send.js').NotifyAccount[]} */ (
    results.filter((a) => a && !(a instanceof Error))
  );
}

/**
 * Record a delivery, inside the owner's own transaction so RLS applies.
 *
 * ON CONFLICT DO NOTHING rather than an error: two processes ticking at once
 * (a rolling deploy) must not turn a duplicate into a 500 in the log.
 */
export async function mark(account, habitId, channel, date) {
  await withUser(account.id, (db) =>
    db.query(
      `INSERT INTO notify_log (user_id, habit_id, channel, date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (habit_id, channel, date) DO NOTHING`,
      [account.id, habitId, channel, date]
    )
  );
}

/**
 * Remember how a destination last behaved, so the settings dialog can say so.
 *
 * Inside the owner's own transaction, like every other write here, so RLS
 * applies. Called only on a CHANGE of state, which is what keeps this from
 * being a write per reminder per channel.
 */
export async function recordOutcome(account, channel, outcome) {
  await withUser(account.id, (db) =>
    db.query(
      `INSERT INTO notify_status
              (user_id, channel, ok, status, error, permanent, mode, date, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (user_id, channel) DO UPDATE
         SET ok = EXCLUDED.ok,
             status = EXCLUDED.status,
             error = EXCLUDED.error,
             permanent = EXCLUDED.permanent,
             mode = EXCLUDED.mode,
             date = EXCLUDED.date,
             at = EXCLUDED.at`,
      [
        account.id, channel, !!outcome.ok, outcome.status ?? null,
        String(outcome.error ?? ''), !!outcome.permanent,
        String(outcome.mode ?? ''), String(outcome.date ?? ''),
      ]
    )
  );
}

/**
 * The last outcome per destination, for `GET /api/notify/status`.
 *
 * Reports only on channels something has actually been attempted for. Whether a
 * destination is *configured* is `channelConfigured`'s question and stays
 * there — two sources of truth about one setting is how they come to disagree.
 */
export async function deliveryStatus(userId) {
  const { rows } = await withUser(userId, (db) =>
    db.query(
      `SELECT channel, ok, status, error, permanent, mode, date, at
         FROM notify_status ORDER BY channel`
    )
  );
  return rows.map((r) => ({
    channel: r.channel,
    ok: r.ok === true,
    status: r.status ?? null,
    error: String(r.error ?? ''),
    permanent: r.permanent === true,
    mode: String(r.mode ?? ''),
    date: String(r.date ?? ''),
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at ?? ''),
  }));
}

/** Drop watermarks nobody will ask about again. */
async function prune(userId, instant) {
  const cutoff = new Date(Number(instant) - KEEP_LOG_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  await withUser(userId, (db) =>
    db.query(`DELETE FROM notify_log WHERE date < $1`, [cutoff])
  );
}

/* ---------- answering from a Discord button ---------- */

/**
 * The adapter the shared interaction handler needs.
 *
 * The tenancy rule is the same one the notifier's scan follows, in reverse: the
 * channel a click came from decides WHOSE data is written, and everything after
 * that goes through `withUser`. The `custom_id` on the button carries a habit
 * id, but it is only ever looked up inside the resolved account — so a forged
 * one finds nothing rather than someone else's habit.
 */
export function interactionAdapter() {
  return {
    /**
     * Which account posts to this channel.
     *
     * A cross-user lookup, so it needs the notifier scope (migration 008) —
     * SELECT on `users` only, and the answer is just an id and settings.
     */
    async resolveChannel(channelId) {
      if (!/^\d{17,20}$/.test(String(channelId ?? ''))) return null;

      const { rows } = await withNotifierScope((db) =>
        db.query(
          `SELECT id, settings, device_time_zone FROM users
            WHERE blocked = false
              AND settings ->> 'discordChannelId' = $1
            LIMIT 2`,
          [String(channelId)]
        )
      );

      // Two accounts pointed at one channel is a configuration mistake, and
      // guessing which one meant it would write to the wrong person's history.
      if (rows.length !== 1) {
        if (rows.length > 1) {
          log.warn('notify.channel_ambiguous', { channel_id: String(channelId), accounts: rows.length });
        } else {
          // Either a stale channel or somebody else's server: the press wrote
          // nothing, and that is worth seeing without being an error.
          log.info('notify.channel_unclaimed', { channel_id: String(channelId) });
        }
        return null;
      }
      // `deviceZone` alongside the settings, because `today()` resolves the
      // same three tiers the tick does — a button press and a reminder must
      // never disagree about which day it is for this account.
      return {
        id: rows[0].id,
        settings: rows[0].settings ?? {},
        deviceZone: String(rows[0].device_time_zone ?? ''),
      };
    },

    today(account) {
      return zonedClock(new Date(),
        resolveTimeZone(account.settings, account.deviceZone ?? '')).date;
    },

    findHabit(account, habitId) {
      return withUser(account.id, (db) =>
        db.query(`SELECT * FROM habits WHERE id = $1`, [habitId])
          .then((r) => r.rows[0] ?? null)
      );
    },

    /**
     * Record what the button meant, through the same validation and the same
     * storage rule as the HTTP API — `parseEntry` then `entryWrite`. A second
     * definition of "not done" living here is exactly the drift those two
     * functions exist to prevent.
     *
     * This is the one write path in this edition that is NOT on the `/api`
     * router, and it is two of them: ntfy's button posts to a route mounted
     * above that router, and Discord's arrives on the gateway socket without
     * touching Express at all. Both land here. So the dashboard memo is
     * invalidated here too, through the same `forgetAccount` the router's
     * middleware calls — without it, pressing Done on a reminder while the PWA
     * is open in a tab served that tab a dashboard computed before the press,
     * with the day still blank, for the length of the TTL.
     *
     * `withUserWrite` for the same reason and one step further: `forgetAccount`
     * clears THIS process's map, and a press taken here is answered by whatever
     * replica the refetch lands on. The version bump is what that other replica
     * can see, and it is a bump this router-shaped rule would have missed
     * exactly as the invalidation did.
     */
    async record(account, { habitId, date, action, value }) {
      // `finally`, and OUTSIDE `withUser`, and both halves are the same rule
      // the router middleware states at its own registration.
      //
      // Outside, because `withUser` COMMITs after its callback returns
      // (`db/pool.js`) — so forgetting from inside forgets before the write is
      // visible to anyone else, and leaves exactly the window the invalidation
      // exists to close: a concurrent `/overview` clears the memo, opens its
      // own transaction, cannot see the uncommitted row, and stores the
      // pre-press dashboard. The commit then lands behind it and the press is
      // painted away for the length of the TTL — the same regression arriving
      // from the other side, and the reason the router wraps `res.end` rather
      // than invalidating on the way in.
      //
      // `finally` rather than on success, because the two errors are not
      // symmetrical: forgetting after a rolled-back write costs one
      // recomputation, and not forgetting after a write that partly landed
      // costs a user their press. Unconditional, exactly as the middleware is
      // unconditional on status.
      try {
        return await withUserWrite(account.id, async (db) => {
          const { rows } = await db.query(`SELECT * FROM habits WHERE id = $1`, [habitId]);
          const habit = rows[0];
          if (!habit) return { ok: false, error: 'That habit no longer exists.' };

          const body = answerBody(habit, { action, value });

          let parsed;
          try {
            parsed = parseEntry(habit, body, { UNSET, YES, SKIP });
          } catch (err) {
            return { ok: false, error: err.message };
          }

          const write = entryWrite(habit, parsed, { UNSET, SKIP });

          if (write.op === 'delete') {
            await db.query(`DELETE FROM entries WHERE habit_id = $1 AND date = $2`,
              [habitId, date]);
          } else {
            await db.query(
              `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (habit_id, date) DO UPDATE
                 SET value = EXCLUDED.value,
                     status = EXCLUDED.status,
                     notes = EXCLUDED.notes`,
              [habitId, account.id, date, write.value, write.status, write.notes]
            );
          }

          return { ok: true, habit, text: answerText(habit, { action, value }) };
        });
      } finally {
        forgetAccount(account.id);
      }
    },
  };
}

/* ---------- answering from an ntfy button ---------- */

/**
 * The adapter `handleNtfyAnswer` needs for this edition.
 *
 * `today` and `record` are exactly `interactionAdapter()`'s — neither one
 * depends on how the account was resolved, so they are reused rather than
 * given a second definition of what a press means to storage.
 */
export function ntfyAnswerAdapter() {
  const { today, record } = interactionAdapter();
  return {
    secret: () => process.env.SESSION_SECRET,

    /**
     * A genuine cross-tenant lookup — unlike personal's single implicit user,
     * this edition's code names an account by its numeric id, and any account
     * may be the one that pressed the button. `resolveChannel` above is the
     * pattern: validate the shape of the reference before it ever reaches a
     * query, then scan through `withNotifierScope` (migration 008's
     * `users_notifier_scan`, `FOR SELECT` only) exactly as the scheduler's own
     * scan does.
     */
    async resolveAccount(ref) {
      if (!/^\d+$/.test(String(ref ?? ''))) return null;

      const { rows } = await withNotifierScope((db) =>
        db.query(
          `SELECT id, settings, device_time_zone FROM users
            WHERE blocked = false AND id = $1`,
          [Number(ref)]
        )
      );
      if (rows.length !== 1) return null;

      // `deviceZone` alongside the settings, for the same reason
      // `resolveChannel` carries it: `today()` has to resolve the same three
      // tiers the tick does, so a button press and a reminder never disagree
      // about which day it is for this account.
      return {
        id: rows[0].id,
        settings: rows[0].settings ?? {},
        deviceZone: String(rows[0].device_time_zone ?? ''),
      };
    },

    today: async (account) => today(account),
    record: async (account, args) => record(account, args),
  };
}

/**
 * Signs an ntfy answer code for one account.
 *
 * Unlike personal, which has nothing to name and always signs the empty
 * reference, this signs `account.id` — the numeric string
 * `ntfyAnswerAdapter`'s `resolveAccount` above expects back.
 *
 * @param {{id: number}} account
 * @param {{habitId: number, date?: string, action: string, value?: number,
 *   test?: boolean}} fields matches `sendToChannel`'s `signAnswer` shape,
 *   where `date` is optional for a test send; defaulted below because
 *   `signNtfyAnswer` itself requires a string.
 * @returns {string}
 */
function signAnswer(account, fields) {
  return signNtfyAnswer({
    secret: process.env.SESSION_SECRET, account: String(account.id), ...fields,
    date: fields.date ?? '',
  });
}

/**
 * Send a test message to every configured server-delivered destination for one
 * user.
 *
 * @param {number} userId
 * @param {Record<string, any>} settings
 * @param {{fetch?: typeof globalThis.fetch}} [deps]
 */
export async function sendTest(userId, settings, deps = {}) {
  const { appUrl, botToken } = notifierConfig(process.env);

  // A stand-in habit: a test has to work before any habit has a reminder time,
  // and must not imply that a real one was due.
  const habit = /** @type {any} */ ({
    id: 0,
    name: 'habiterall test',
    description: '',
    type: 'boolean',
    color: '#3b82f6',
    target_value: 0,
    target_type: 'at_least',
    unit: '',
  });

  const results = [];
  for (const channel of serverChannels(settings, { bot: !!botToken })) {
    const result = await sendToChannel(
      channel,
      {
        habit, settings, test: true, appUrl, botToken,
        // Live but inert: a `test: true` code is exempt from the habit-id and
        // date checks and never reaches storage, so the test button
        // exercises the whole interactive path rather than only the send.
        signAnswer: (fields) => signAnswer({ id: userId }, fields),
      },
      deps
    );
    results.push({ channel, ok: result.ok, error: result.ok ? undefined : result.error });
    // A test is a real delivery attempt on the same path, so it answers the
    // same question `/notify/status` reports on. Recorded unconditionally
    // rather than on a change of state: a press here is a deliberate act by one
    // person, not a tick that runs every minute, and it is how a warning about
    // a webhook the user has just replaced gets cleared without waiting for
    // tomorrow's reminder.
    await recordOutcome({ id: userId }, channel, {
      ok: result.ok, status: result.status, error: result.error,
      permanent: !!result.permanent, mode: result.mode, date: '',
    });
  }
  return results;
}

/**
 * Start the reminder loop. Entry points only.
 *
 * `deps.startNotifier` exists for one test and is the only way to write it.
 * The delivery limit this edition derives is read by `runTick` several layers
 * inside the shared module, and `startNotifier` hands back only `{stop}` — so
 * nothing observes whether `start()` passed the number along. It did not need
 * to: deleting `deliveryConcurrency: DELIVERY_CONCURRENCY` below restores the
 * literal 8 this replaced and leaves unit, cloud, tenancy and typecheck green.
 * The alternative — call the real `startNotifier` in a test and inspect what it
 * received — is not available, because it ticks IMMEDIATELY and synchronously
 * on construction, against whatever the suite's database holds, with a real
 * `fetch`. So the seam is here rather than a spy.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{startNotifier?: typeof startNotifier}} [deps]
 * @returns {{stop: () => void} | null} null when disabled
 */
export function start(env = process.env, deps = {}) {
  const begin = deps.startNotifier ?? startNotifier;
  const config = notifierConfig(env);
  if (!config.enabled) {
    log.warn('notify.disabled', { reason: 'HABITERALL_NOTIFY=off' });
    return null;
  }

  // `ntfy_answers` said once, at startup, for the same reason `mode` is: with
  // no `app_url` an ntfy reminder still goes out, just with no buttons on it,
  // and nothing else says so — `channelInteractive` otherwise has no caller
  // at all.
  log.info('notify.starting', {
    mode: config.botToken ? 'bot' : 'webhook',
    interval_ms: config.intervalMs,
    app_url: config.appUrl || '(unset)',
    max_accounts_per_tick: MAX_ACCOUNTS_PER_TICK,
    // Both are DERIVED from `PG_POOL_MAX` and had no surface at all. An
    // operator who sets the pool to 2 to fit a small managed Postgres silently
    // gets a tick one account wide; one who raises it to 40 expecting a faster
    // tick silently gets the 6/8 caps. Both are correct, and neither was
    // discoverable from anywhere but the source.
    collect_concurrency: COLLECT_CONCURRENCY,
    delivery_concurrency: DELIVERY_CONCURRENCY,
    ntfy_answers: channelInteractive('ntfy', {}, { appUrl: config.appUrl }) ? 'on' : 'off',
  });

  let lastPrunedDay = '';

  // Only for receiving button presses; sending needs no socket. One connection
  // per instance, whatever the number of accounts — the bot is the operator's,
  // and each user points it at their own channel.
  const gateway = config.botToken
    ? connectGateway({
      token: config.botToken,
      log,
      onInteraction: (interaction) =>
        handleInteraction(interaction, { ...interactionAdapter(), log }),
    })
    : null;

  // Named rather than passed inline, so the wiring is observable. Everything
  // below is a DECISION the shared suite already pins — `deliveryConcurrency:
  // 1` serialises two Discord accounts, `2` lets them overlap — and none of
  // that says this edition actually HANDS its derived limit over. Deleting the
  // line below restores the literal 8 this commit was written to remove and
  // left every suite green, which is the defect class the root `CLAUDE.md`
  // names by hand: pinning the decision is not pinning the wiring.
  const ctx = {
    log,
    intervalMs: config.intervalMs,
    appUrl: config.appUrl,
    botToken: config.botToken,
    deliveryConcurrency: DELIVERY_CONCURRENCY,
    // Travels the same route `botToken` and `appUrl` already do: no reaching
    // into `process.env` from inside `shared/src` for it.
    signAnswer,
    collect: async (instant) => {
      const accounts = await collect(instant);

      // Once a day, not once a minute: this is housekeeping and it costs a
      // transaction per account.
      const day = new Date(Number(instant)).toISOString().slice(0, 10);
      if (day !== lastPrunedDay) {
        lastPrunedDay = day;
        for (const account of accounts) {
          await prune(account.id, instant).catch((err) =>
            log.warn('notify.prune_failed', { user: account.id }, err));
        }
      }

      return accounts;
    },
    mark,
    recordOutcome,
  };

  const notifier = begin(ctx);

  return {
    stop() {
      notifier.stop();
      gateway?.stop();
    },
  };
}
