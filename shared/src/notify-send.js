/**
 * Delivering reminders, and the loop that decides when to.
 *
 * Separate from notify.js because this is the one file in `shared/src` that
 * talks to the network — and it does so only through a `fetch` it is handed,
 * so nothing here binds to an ambient HTTP client and every path below is
 * testable without one.
 *
 * Both editions supply the same small adapter and get the same behaviour:
 *
 *   collect() -> [{ id, settings, habits, doneToday, alreadySent }]
 *   mark(account, habitId, channel, date)
 *
 * `collect` reads storage, `mark` writes the watermark that stops a reminder
 * being sent twice. Everything between them is here.
 */

import {
  CHANNELS, dueReminders, discordPayload, reminderMessage, serverChannels,
} from './notify.js';
import { postReminder } from './discord.js';

/** A webhook that hangs must not hold up the rest of the tick. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * One user's world, as a tick needs it: read once, up front, so no storage is
 * touched while a webhook is in flight.
 *
 * @typedef {object} NotifyAccount
 * @property {number|null} [id] for the log; the personal edition has none
 * @property {Record<string, any>} [settings]
 * @property {import('./types.js').Habit[]} [habits] those with a reminder time
 * @property {Set<number>} [doneToday]
 * @property {(habitId: number, channel: string, date: string) => boolean} [alreadySent]
 */

/**
 * @typedef {object} NotifyContext
 * @property {(instant: Date|number) => Promise<NotifyAccount[]>|NotifyAccount[]} collect
 * @property {(account: NotifyAccount, habitId: number, channel: string, date: string) => any} mark
 * @property {Date|number} [instant]
 * @property {string} [appUrl] this deployment's public address, for the link
 * @property {string} [botToken] DISCORD_BOT_TOKEN, when the instance has one
 * @property {typeof globalThis.fetch} [fetch]
 * @property {{warn?: Function, error?: Function}} [log]
 * @property {number} [intervalMs]
 */

/**
 * Post one payload to a Discord webhook.
 *
 * Returns rather than throws, because a caller mid-tick needs to tell three
 * situations apart: it worked, it failed and retrying may help, or the
 * webhook is gone and retrying never will. A deleted webhook answers 404
 * forever, and treating that as retryable is how a notifier ends up hammering
 * a dead URL every minute for months.
 *
 * @param {string} url
 * @param {unknown} payload
 * @param {{fetch?: typeof globalThis.fetch, timeoutMs?: number}} [deps]
 * @returns {Promise<{ok: boolean, status: number, error?: string, permanent?: boolean, retryAfterMs?: number}>}
 */
export async function postWebhook(url, payload, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // No cookies, no redirects. A webhook host that answers 302 is not
      // one we agreed to talk to, and following it would walk straight
      // around the host allowlist in notify.js.
      redirect: 'manual',
    });

    if (res.status === 429) {
      // Discord's own header is seconds, as a decimal string. Absent or
      // nonsense means "wait a moment" — never zero, which the caller would
      // read as "no wait was asked for" and therefore as "do not retry".
      const seconds = Number(res.headers?.get?.('retry-after'));
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 1;
      return {
        ok: false,
        status: 429,
        error: 'rate limited by Discord',
        retryAfterMs: wait * 1000,
      };
    }

    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        permanent: true,
        error: 'the webhook was deleted or is no longer accepted — create a new one',
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, error: `webhook returned ${res.status}` };
    }

    return { ok: true, status: res.status };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: aborted ? `no response within ${timeoutMs}ms` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one habit's reminder to one channel.
 *
 * @param {string} channel
 * @param {object} args
 * @param {import('./types.js').Habit} args.habit
 * @param {Record<string, any>} args.settings
 * @param {string} [args.date]
 * @param {string} [args.appUrl]
 * @param {boolean} [args.test]
 * @param {string} [args.botToken] this instance's bot token, if it has one
 * @param {{fetch?: typeof globalThis.fetch}} [deps]
 */
export async function sendToChannel(channel, args, deps = {}) {
  const { habit, settings, date = '', appUrl = '', test = false, botToken = '' } = args;

  if (CHANNELS[channel]?.delivery !== 'server') {
    // 'android' reaches here only if someone asks for it explicitly; it is
    // delivered by the phone itself and there is nothing to post.
    return { ok: false, status: 0, error: `${channel} is delivered by the device` };
  }

  if (channel === 'discord') {
    // Bot first when it is available: it is the only mode that can carry
    // buttons, so a user who has configured both gets the interactive version.
    // The webhook remains a complete fallback for anyone who would rather not
    // create an application.
    if (botToken && settings.discordChannelId) {
      return postReminder({
        token: botToken,
        channelId: settings.discordChannelId,
        habit, date, appUrl, test,
      }, deps);
    }

    const message = reminderMessage(habit, { test });
    return postWebhook(
      settings.discordWebhook,
      discordPayload({ habit, message, date, appUrl }),
      deps
    );
  }

  return { ok: false, status: 0, error: `unknown channel ${channel}` };
}

/**
 * Deliver everything due for one account.
 *
 * The watermark is written only on success, so a webhook that was down for a
 * minute still gets its reminder on the next tick — inside the catch-up
 * window from notify.js, and not after it.
 *
 * @param {NotifyAccount} account
 * @param {NotifyContext} ctx
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function deliverAccount(account, ctx) {
  const settings = account.settings ?? {};
  const channels = serverChannels(settings, { bot: !!ctx.botToken });
  if (!channels.length) return { sent: 0, failed: 0 };

  const log = ctx.log ?? console;
  let sent = 0;
  let failed = 0;

  for (const channel of channels) {
    const due = dueReminders({
      habits: account.habits ?? [],
      instant: ctx.instant,
      timeZone: settings.notifyTimezone ?? '',
      doneToday: account.doneToday,
      // Per channel: adding Discord to an account must not be silenced by the
      // fact that the phone already handled that habit this morning.
      alreadySent: (habitId, date) => account.alreadySent?.(habitId, channel, date),
    });

    for (const item of due) {
      const payload = {
        habit: item.habit, settings, date: item.date,
        appUrl: ctx.appUrl, botToken: ctx.botToken,
      };
      let result = await sendToChannel(channel, payload, { fetch: ctx.fetch });

      // Discord's limit is a handful of posts every couple of seconds, so a
      // morning where five habits come due at once can trip it. Honouring the
      // wait it asks for turns that into a delivered reminder; leaving it to
      // the next tick would trip the same limit again a minute later. Once
      // only — a second 429 means something else is wrong.
      if (result.retryAfterMs) {
        await new Promise((r) => setTimeout(r, result.retryAfterMs));
        result = await sendToChannel(channel, payload, { fetch: ctx.fetch });
      }

      if (result.ok) {
        await ctx.mark(account, item.habit.id, channel, item.date);
        sent++;
        continue;
      }

      failed++;
      // A permanent failure is recorded as sent: the reminder is never going
      // to arrive, and retrying it every minute until midnight helps nobody.
      // The settings dialog's test button is how the user finds out.
      if (result.permanent) await ctx.mark(account, item.habit.id, channel, item.date);

      log.warn?.(
        `notify: ${channel} failed for habit ${item.habit.id}` +
        `${account.id != null ? ` (account ${account.id})` : ''}: ${result.error}`
      );
    }
  }

  return { sent, failed };
}

/**
 * One pass over every account that has a server-delivered channel enabled.
 *
 * `collect` is handed the instant rather than reading its own clock. It has to
 * resolve the user's local date to answer "already sent today", and if that
 * came from a second `new Date()` the two could land either side of local
 * midnight — the tick would then check yesterday's watermark against today's
 * date and send a reminder twice.
 *
 * @param {NotifyContext} ctx
 */
export async function runTick(ctx) {
  const instant = ctx.instant ?? new Date();
  const log = ctx.log ?? console;
  const accounts = await ctx.collect(instant);

  let sent = 0;
  let failed = 0;
  for (const account of accounts) {
    try {
      const result = await deliverAccount(account, { ...ctx, instant, log });
      sent += result.sent;
      failed += result.failed;
    } catch (err) {
      // One account's storage error must not stop the others'.
      log.error?.(`notify: account ${account?.id} failed:`, err);
    }
  }
  return { accounts: accounts.length, sent, failed };
}

/** Default cadence. A minute is the resolution a 'HH:MM' reminder has. */
export const TICK_MS = 60_000;

/**
 * Start the notifier.
 *
 * Overlapping ticks are skipped rather than queued: a slow webhook must not
 * let a second pass start and send the same reminder twice on the strength of
 * a watermark the first pass has not written yet.
 *
 * Call this from an entry point only, never at import time — a test that
 * imports the server would otherwise start posting to the user's real
 * Discord channel.
 *
 * @param {NotifyContext} ctx
 * @returns {{stop: () => void}}
 */
export function startNotifier(ctx) {
  const intervalMs = ctx.intervalMs ?? TICK_MS;
  const log = ctx.log ?? console;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runTick({ ...ctx, log });
    } catch (err) {
      log.error?.('notify: tick failed:', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Nothing here should keep a process alive on its own; the HTTP server is
  // what does that.
  timer.unref?.();
  tick();

  return { stop: () => clearInterval(timer) };
}

/**
 * Read the notifier's environment. Shared so both editions spell the
 * variables the same way and document them once.
 *
 * @param {Record<string, string|undefined>} env
 */
export function notifierConfig(env) {
  const interval = Number(env.HABITERALL_NOTIFY_INTERVAL_MS);
  return {
    // Opt-out rather than opt-in: a user who has configured a webhook in the
    // settings dialog has already opted in, and a second switch in the
    // environment would look like the feature was broken.
    enabled: (env.HABITERALL_NOTIFY ?? 'on').toLowerCase() !== 'off',
    intervalMs: Number.isFinite(interval) && interval >= 1000 ? interval : TICK_MS,
    // Used to link the embed back to the app. PUBLIC_URL is cloud's existing
    // name for it; HABITERALL_PUBLIC_URL is the personal edition's, where
    // there is otherwise no reason to know the address.
    appUrl: env.HABITERALL_PUBLIC_URL ?? env.PUBLIC_URL ?? '',
    // An INSTANCE credential, deliberately not a per-user setting: a bot token
    // can post to every channel the bot is in, and `GET /api/settings` hands
    // user settings to the browser. Keeping it in the environment means a
    // stolen session cannot read it.
    botToken: env.DISCORD_BOT_TOKEN ?? '',
  };
}
