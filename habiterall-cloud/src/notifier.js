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

import { withNotifierScope, withUser } from './db/pool.js';
import {
  answeredIds, answerText, CHANNELS, needsServerDelivery, serverChannels,
  zonedClock,
} from '@habiterall/shared/notify.js';
import {
  notifierConfig, sendToChannel, startNotifier,
} from '@habiterall/shared/notify-send.js';
import { handleInteraction } from '@habiterall/shared/discord.js';
import { connectGateway } from '@habiterall/shared/discord-gateway.js';
import { UNSET, YES, SKIP } from '@habiterall/shared/constants.js';
import { entryWrite, parseEntry } from '@habiterall/shared/validate.js';
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
      `SELECT id, settings FROM users
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
  const accounts = [];

  for (const row of await candidates()) {
    const settings = row.settings ?? {};
    // The scan's SQL predicate is deliberately loose (it cannot tell whether a
    // webhook URL or a channel id is actually filled in); this is the real test,
    // and it needs to know whether this instance has a bot at all.
    if (!needsServerDelivery(settings, { bot: !!notifierConfig(process.env).botToken })) {
      continue;
    }

    const clock = zonedClock(instant, settings.notifyTimezone ?? '');

    const account = await withUser(row.id, async (db) => {
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

      const already = new Set(sent.map((s) => `${s.habit_id}:${s.channel}`));
      return {
        id: row.id,
        settings,
        habits,
        doneToday: answeredIds(habits, entries),
        alreadySent: (habitId, channel) => already.has(`${habitId}:${channel}`),
      };
    });

    if (account) accounts.push(account);
  }

  return accounts;
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
          `SELECT id, settings FROM users
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
      return { id: rows[0].id, settings: rows[0].settings ?? {} };
    },

    today(account) {
      return zonedClock(new Date(), account.settings.notifyTimezone ?? '').date;
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
     */
    async record(account, { habitId, date, action, value }) {
      return withUser(account.id, async (db) => {
        const { rows } = await db.query(`SELECT * FROM habits WHERE id = $1`, [habitId]);
        const habit = rows[0];
        if (!habit) return { ok: false, error: 'That habit no longer exists.' };

        const body = action === 'skip' ? { status: 'skip' }
          : action === 'yes' ? { value: YES }
            : action === 'no' ? { value: UNSET }
              : { value };

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
    },
  };
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
      channel, { habit, settings, test: true, appUrl, botToken }, deps
    );
    results.push({ channel, ok: result.ok, error: result.ok ? undefined : result.error });
  }
  return results;
}

/**
 * Start the reminder loop. Entry points only.
 *
 * @returns {{stop: () => void} | null} null when disabled
 */
export function start(env = process.env) {
  const config = notifierConfig(env);
  if (!config.enabled) {
    log.warn('notify.disabled', { reason: 'HABITERALL_NOTIFY=off' });
    return null;
  }

  log.info('notify.starting', {
    mode: config.botToken ? 'bot' : 'webhook',
    interval_ms: config.intervalMs,
    app_url: config.appUrl || '(unset)',
    max_accounts_per_tick: MAX_ACCOUNTS_PER_TICK,
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

  const notifier = startNotifier({
    log,
    intervalMs: config.intervalMs,
    appUrl: config.appUrl,
    botToken: config.botToken,
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
  });

  return {
    stop() {
      notifier.stop();
      gateway?.stop();
    },
  };
}
