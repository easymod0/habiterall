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
  answeredIds, answerText, needsServerDelivery, serverChannels, zonedClock,
} from '@habiterall/shared/notify.js';
import {
  notifierConfig, sendToChannel, startNotifier,
} from '@habiterall/shared/notify-send.js';
import { handleInteraction } from '@habiterall/shared/discord.js';
import { connectGateway } from '@habiterall/shared/discord-gateway.js';
import { entryWrite, parseEntry } from '@habiterall/shared/validate.js';
import { log } from '@habiterall/shared/log.js';

/** Rows older than this are of no interest; they are only a "did we?" record. */
const KEEP_LOG_DAYS = 45;

const q = {
  settings: db.prepare(`SELECT key, value FROM settings`),
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
};

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
  if (!needsServerDelivery(settings, { bot: !!botToken })) return [];

  const habits = /** @type {any[]} */ (q.habits.all());
  if (!habits.length) return [];

  // The user's own day, not the server's: `zonedClock` is what decides which
  // date "already done" and "already sent" are asked about.
  const clock = zonedClock(now, settings.notifyTimezone ?? '');

  const doneToday = answeredIds(habits, /** @type {any} */ (q.entriesOn.all(clock.date)));
  const sent = new Set(
    q.sentOn.all(clock.date).map((r) => `${r.habit_id}:${r.channel}`)
  );

  return [{
    id: null,                 // single user; nothing to identify
    settings,
    habits,
    doneToday,
    alreadySent: (habitId, channel) => sent.has(`${habitId}:${channel}`),
  }];
}

/** Record a delivery so it is not repeated after a restart. */
export function mark(account, habitId, channel, date) {
  q.markSent.run(habitId, channel, date);
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
      return zonedClock(new Date(), account.settings.notifyTimezone ?? '').date;
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
      const cutoff = new Date(Number(instant) - KEEP_LOG_DAYS * 86_400_000)
        .toISOString().slice(0, 10);
      q.prune.run(cutoff);
      return collect(instant);
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
