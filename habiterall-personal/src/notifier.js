/**
 * Server-sent reminders, personal edition.
 *
 * All the scheduling lives in @habiterall/shared/notify.js and the delivery in
 * notify-send.js; this file is only the storage adapter — read the one
 * implicit user's settings and habits, and record what has been sent.
 *
 * The Android channel is not handled here at all: the phone schedules its own
 * alarms from `habits.reminder_time`, which is what keeps reminders working
 * when this process is not running.
 */

import { db, UNSET, YES, SKIP } from './db.js';
import {
  answeredIds, answerText, needsServerDelivery, resolveTimeZone, serverChannels,
  zonedClock,
} from '@habiterall/shared/notify.js';
import {
  notifierConfig, sendToChannel, startNotifier, warnUnreachable,
} from '@habiterall/shared/notify-send.js';
import { handleInteraction } from '@habiterall/shared/discord.js';
import { connectGateway } from '@habiterall/shared/discord-gateway.js';
import { entryWrite, parseEntry } from '@habiterall/shared/validate.js';
import { log } from '@habiterall/shared/log.js';

/** Rows older than this are of no interest; they are only a "did we?" record. */
const KEEP_LOG_DAYS = 45;

const q = {
  settings: db.prepare(`SELECT key, value FROM settings`),
  deviceClock: db.prepare(`SELECT time_zone FROM device_clock WHERE id = 1`),
  habits: db.prepare(`
    SELECT * FROM habits
     WHERE archived = 0 AND reminder_time <> ''
     ORDER BY position, id
  `),
  entriesOn: db.prepare(`
    SELECT habit_id, value, status FROM entries WHERE date = ?
  `),
  sentOn: db.prepare(`SELECT habit_id, channel FROM notify_log WHERE date = ?`),
  habitById: db.prepare(`SELECT * FROM habits WHERE id = ?`),
  upsertEntry: db.prepare(`
    INSERT INTO entries (habit_id, date, value, status, notes) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(habit_id, date) DO UPDATE SET value = excluded.value,
                                              status = excluded.status,
                                              notes = excluded.notes
  `),
  deleteEntry: db.prepare(`DELETE FROM entries WHERE habit_id = ? AND date = ?`),
  markSent: db.prepare(`
    INSERT INTO notify_log (habit_id, channel, date) VALUES (?, ?, ?)
    ON CONFLICT(habit_id, channel, date) DO NOTHING
  `),
  prune: db.prepare(`DELETE FROM notify_log WHERE date < ?`),
  allStatus: db.prepare(`SELECT * FROM notify_status ORDER BY channel`),
  upsertStatus: db.prepare(`
    INSERT INTO notify_status (channel, ok, status, error, permanent, mode, date, at)
    -- ISO 8601 with the Z, because the cloud edition's TIMESTAMPTZ serialises
    -- that way and the two editions promise the same API. SQLite's bare
    -- datetime('now') is "2026-08-14 22:45:20" — space-separated and silent
    -- about its zone, which is the kind of drift this project has paid for
    -- before: archived coming back as 0 here and false there.
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(channel) DO UPDATE SET ok = excluded.ok,
                                       status = excluded.status,
                                       error = excluded.error,
                                       permanent = excluded.permanent,
                                       mode = excluded.mode,
                                       date = excluded.date,
                                       at = excluded.at
  `),
};

/** What the last client to check in said its clock was; '' if none has. */
function deviceZone() {
  try {
    return String(q.deviceClock.get()?.time_zone ?? '');
  } catch {
    return '';                 // an older database, before the table existed
  }
}

/** The stored preferences, as the plain object the shared code expects. */
export function loadSettings() {
  const out = {};
  for (const { key, value } of q.settings.all()) {
    try { out[String(key)] = JSON.parse(String(value)); }
    catch { /* a corrupt row is not worth failing a reminder over */ }
  }
  return out;
}

/**
 * The one account, or nothing if it has no server-delivered destination.
 *
 * Everything the tick needs is read here, in one go, so `deliverAccount` never
 * touches storage while it is awaiting a webhook.
 *
 * @param {Date|number} [now]
 */
export function collect(now = new Date()) {
  const settings = loadSettings();

  // `{ bot }` is not optional context — it is half the readiness rule.
  // `CHANNELS.discord.ready` is "a webhook URL **or** (a bot **and** a channel
  // id)", so omitting it here made bot-only configuration — a channel id and no
  // webhook, which is the recommended setup — report as nothing to deliver, and
  // this returned [] on every tick, forever, in silence. `sendTest` passed the
  // flag, so the test button worked and only the real reminders never came.
  // The cloud edition has always passed it; this is why that must not drift.
  const { botToken } = notifierConfig(process.env);
  // Before the early return, and that is the whole point: an account skipped for
  // having nothing configured is the one case that produced no log line at all.
  warnUnreachable({ id: null, settings }, { botToken, log });
  if (!needsServerDelivery(settings, { bot: !!botToken })) return [];

  const habits = /** @type {any[]} */ (q.habits.all());
  if (!habits.length) return [];

  // The user's own day, not the server's: `zonedClock` is what decides which
  // date "already done" and "already sent" are asked about, and
  // `resolveTimeZone` is what decides whose clock that is — the zone the
  // account NAMED, else the one its last client reported, else this server's.
  const timeZone = resolveTimeZone(settings, deviceZone());
  const clock = zonedClock(now, timeZone);

  const doneToday = answeredIds(habits, /** @type {any} */ (q.entriesOn.all(clock.date)));
  const sent = new Set(
    q.sentOn.all(clock.date).map((r) => `${r.habit_id}:${r.channel}`)
  );

  return [{
    id: null,                 // single user; nothing to identify
    settings,
    // Resolved once and carried, so `deliverAccount` cannot decide it again.
    timeZone,
    habits,
    doneToday,
    alreadySent: (habitId, channel) => sent.has(`${habitId}:${channel}`),
    // Read here rather than at write time so `recordOutcome` is only called
    // when the news is new — see `noteOutcome` in notify-send.js, which needs
    // the stored REASON and not merely whether it worked.
    delivered: Object.fromEntries(
      q.allStatus.all().map((r) => [String(r.channel), {
        ok: r.ok === 1,
        status: r.status == null ? undefined : Number(r.status),
        error: String(r.error ?? ''),
        permanent: r.permanent === 1,
      }])
    ),
  }];
}

/** Record a delivery so it is not repeated after a restart. */
export function mark(account, habitId, channel, date) {
  q.markSent.run(habitId, channel, date);
}

/**
 * Remember how a destination last behaved, so the settings dialog can say so.
 *
 * Called only on a CHANGE of state, which is what keeps this from being a write
 * per reminder per channel.
 */
export function recordOutcome(account, channel, outcome) {
  q.upsertStatus.run(
    channel,
    outcome.ok ? 1 : 0,
    outcome.status ?? null,
    String(outcome.error ?? ''),
    outcome.permanent ? 1 : 0,
    String(outcome.mode ?? ''),
    String(outcome.date ?? '')
  );
}

/**
 * The last outcome per destination, for `GET /api/notify/status`.
 *
 * Reports only on channels something has actually been attempted for. Whether a
 * destination is *configured* is `channelConfigured`'s question and stays
 * there — two sources of truth about one setting is how they come to disagree.
 */
export function deliveryStatus() {
  return q.allStatus.all().map((r) => ({
    channel: String(r.channel),
    ok: r.ok === 1,
    status: r.status ?? null,
    error: String(r.error ?? ''),
    permanent: r.permanent === 1,
    mode: String(r.mode ?? ''),
    date: String(r.date ?? ''),
    at: String(r.at ?? ''),
  }));
}

/* ---------- answering from a Discord button ---------- */

/**
 * The adapter the shared interaction handler needs.
 *
 * This edition has one implicit user, so "which account" is only ever a check
 * that the click came from the channel this install posts to — an interaction
 * from anywhere else is not ours to record.
 */
export function interactionAdapter() {
  return {
    resolveChannel(channelId) {
      const settings = loadSettings();
      return settings.discordChannelId && settings.discordChannelId === channelId
        ? { id: null, settings }
        : null;
    },

    today(account) {
      return zonedClock(new Date(),
        resolveTimeZone(account.settings, deviceZone())).date;
    },

    findHabit(account, habitId) {
      return q.habitById.get(habitId) ?? null;
    },

    /**
     * Record what the button meant.
     *
     * Deliberately routed through the same `parseEntry` and `entryWrite` as the
     * HTTP API: a button that wrote entries its own way would be a second
     * definition of what "not done" means, and the two would drift.
     */
    record(account, { habitId, date, action, value }) {
      const habit = /** @type {any} */ (q.habitById.get(habitId));
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
      if (write.op === 'delete') q.deleteEntry.run(habitId, date);
      else q.upsertEntry.run(habitId, date, write.value, write.status, write.notes);

      return { ok: true, habit, text: answerText(habit, { action, value }) };
    },
  };
}

/**
 * Send a test message to every configured server-delivered destination.
 *
 * Returns one result per channel rather than throwing, so the settings dialog
 * can say which destination worked.
 *
 * @param {{fetch?: typeof globalThis.fetch}} [deps]
 */
export async function sendTest(deps = {}) {
  const settings = loadSettings();
  const { appUrl, botToken } = notifierConfig(process.env);
  const channels = serverChannels(settings, { bot: !!botToken });

  // A believable habit rather than a real one: a test must work before any
  // habit has a reminder time, and must not claim a habit was due. Its buttons
  // carry the test id, so pressing one answers "nothing was recorded" — which
  // is what makes this a test of the whole interactive path and not just of the
  // send.
  const habit = {
    id: 0,
    name: 'habiterall test',
    description: '',
    type: 'boolean',
    color: '#3b82f6',
    target_value: 0,
    target_type: 'at_least',
    unit: '',
  };

  const results = [];
  for (const channel of channels) {
    const result = await sendToChannel(
      channel,
      { habit: /** @type {any} */ (habit), settings, test: true, appUrl, botToken },
      deps
    );
    results.push({ channel, ok: result.ok, error: result.ok ? undefined : result.error });
    // A test is a real delivery attempt on the same path, so it answers the
    // same question `/notify/status` reports on. Recorded unconditionally
    // rather than on a change of state: a press here is a deliberate act by one
    // person, not a tick that runs every minute, and it is how a warning about
    // a webhook the user has just replaced gets cleared without waiting for
    // tomorrow's reminder.
    recordOutcome({ id: null }, channel, {
      ok: result.ok, status: result.status, error: result.error,
      permanent: !!result.permanent, mode: result.mode, date: '',
    });
  }
  return results;
}

/**
 * Start the reminder loop. Entry points only — importing this module must not
 * begin posting to somebody's Discord channel.
 *
 * @returns {{stop: () => void} | null} null when disabled
 */
export function start(env = process.env) {
  const config = notifierConfig(env);
  if (!config.enabled) {
    log.warn('notify.disabled', { reason: 'HABITERALL_NOTIFY=off' });
    return null;
  }

  // Said once, at startup, because it is the difference between buttons and
  // plain text and there is no way to tell from the app which one you have.
  log.info('notify.starting', {
    mode: config.botToken ? 'bot' : 'webhook',
    interval_ms: config.intervalMs,
    app_url: config.appUrl || '(unset)',
  });

  // The gateway is only for receiving button presses, so it is opened only when
  // there is a bot to receive them with. Sending needs no socket.
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
    collect: (instant) => {
      // Cheap, and it keeps the table from growing without bound in a
      // long-lived install.
      //
      // Guarded, because it is HOUSEKEEPING and this is the first thing a tick
      // does: an unguarded SQLITE_BUSY here threw out of `collect`, which is
      // awaited before `runTick`'s per-account try, so a stray lock on the
      // watermark table abandoned the whole tick before a single reminder had
      // been considered. Cloud has always guarded its own `prune`; this was the
      // asymmetry.
      const cutoff = new Date(Number(instant) - KEEP_LOG_DAYS * 86_400_000)
        .toISOString().slice(0, 10);
      try {
        q.prune.run(cutoff);
      } catch (err) {
        log.warn?.('notify.prune_failed', {}, err);
      }
      return collect(instant);
    },
    mark,
    recordOutcome,
  });

  return {
    stop() {
      notifier.stop();
      gateway?.stop();
    },
  };
}
