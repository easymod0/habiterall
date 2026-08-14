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
  unreachableChannels,
} from './notify.js';
import { postReminder } from './discord.js';

/** A webhook that hangs must not hold up the rest of the tick. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * What has already been said, so a tick every minute does not repeat it.
 *
 * Both users of this are conditions that persist until someone changes a
 * setting: a destination that cannot deliver, and a reminder dropped for being
 * too late. Logged once each, they are actionable; logged 1,440 times a day they
 * are the reason nobody reads the log.
 *
 * Cleared wholesale past a bound rather than pruned. The keys carry a date, so
 * the set grows by a handful a day and the only cost of forgetting is saying
 * something twice — where the cost of a leak in a process that runs for months
 * is unbounded memory.
 */
const said = new Set();
const MAX_SAID = 5_000;

/** @returns {boolean} whether this is the first time, and so worth saying */
function once(key) {
  if (said.has(key)) return false;
  if (said.size >= MAX_SAID) said.clear();
  said.add(key);
  return true;
}

/** Test seam: the dedupe is process-wide state, and a test needs it empty. */
export function resetSaid() {
  said.clear();
}

/**
 * Say — once — that a destination the user has switched on cannot deliver.
 *
 * Called by each edition's `collect`, because that is where an account is
 * skipped for exactly this reason and the shared tick never sees it. One
 * implementation rather than two, so the wording and the dedupe cannot drift.
 *
 * @param {NotifyAccount} account
 * @param {{botToken?: string, log?: any}} [ctx]
 * @returns {string[]} the unreachable channel ids
 */
export function warnUnreachable(account, ctx = {}) {
  const settings = account?.settings ?? {};
  const log = ctx.log ?? console;
  const broken = unreachableChannels(settings, { bot: !!ctx.botToken });
  const who = account?.id ?? 'self';

  for (const channel of broken) {
    // Not keyed on a date: this is a configuration, and it stays wrong until
    // someone fixes it. Saying so once per process start is the right cadence.
    if (!once(`unreachable:${who}:${channel}`)) continue;

    const botOnly = channel === 'discord' && settings.discordChannelId && !ctx.botToken;
    log.warn?.('notify.unreachable', {
      channel,
      user: account?.id ?? null,
      reason: botOnly
        ? 'a channel id needs this instance to have a DISCORD_BOT_TOKEN — with only a URL, use the webhook field'
        : 'switched on but nothing is configured for it',
    });
  }
  return broken;
}

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
 * What a delivery attempt reports back.
 *
 * @typedef {object} SendResult
 * @property {boolean} ok
 * @property {number} [status] the HTTP status, or 0 if there was no response
 * @property {string} [error]
 * @property {boolean} [permanent] retrying will never work — a deleted webhook
 * @property {number} [retryAfterMs] the wait Discord asked for
 * @property {'bot'|'webhook'} [mode] which of the two paths answered
 */

/**
 * @typedef {object} NotifyContext
 * @property {(instant: Date|number) => Promise<NotifyAccount[]>|NotifyAccount[]} collect
 * @property {(account: NotifyAccount, habitId: number, channel: string, date: string) => any} mark
 * @property {Date|number} [instant]
 * @property {string} [appUrl] this deployment's public address, for the link
 * @property {string} [botToken] DISCORD_BOT_TOKEN, when the instance has one
 * @property {typeof globalThis.fetch} [fetch]
 * @property {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [log]
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
 * @returns {Promise<SendResult>}
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
 * @returns {Promise<SendResult>}
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
    // `mode` is carried back so a log can say which of the two answered. The
    // difference is visible to the user — buttons or plain text — and "I am not
    // getting buttons" is otherwise a question only the operator's environment
    // can answer.
    if (botToken && settings.discordChannelId) {
      const result = await postReminder({
        token: botToken,
        channelId: settings.discordChannelId,
        habit, date, appUrl, test,
      }, deps);
      return { mode: 'bot', ...result };
    }

    const message = reminderMessage(habit, { test });
    const result = await postWebhook(
      settings.discordWebhook,
      discordPayload({ habit, message, date, appUrl }),
      deps
    );
    return { mode: 'webhook', ...result };
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
 * @returns {Promise<{sent: number, failed: number, skipped: Record<string, number>}>}
 */
export async function deliverAccount(account, ctx) {
  const settings = account.settings ?? {};
  const channels = serverChannels(settings, { bot: !!ctx.botToken });
  if (!channels.length) return { sent: 0, failed: 0, skipped: {} };

  const log = ctx.log ?? console;
  let sent = 0;
  let failed = 0;
  /** reason -> count, for the tick summary. */
  const skipped = {};

  for (const channel of channels) {
    const due = dueReminders({
      habits: account.habits ?? [],
      instant: ctx.instant,
      timeZone: settings.notifyTimezone ?? '',
      doneToday: account.doneToday,
      // Per channel: adding Discord to an account must not be silenced by the
      // fact that the phone already handled that habit this morning.
      alreadySent: (habitId, date) => account.alreadySent?.(habitId, channel, date),
      // Counted for every tick, spelled out per habit only at debug level:
      // an instance with a hundred accounts would otherwise write a line per
      // habit per minute, which buries the sends nobody wants to miss.
      onSkip: (habit, reason, detail) => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        log.debug?.('notify.skip', {
          channel, habit: habit.id, user: account.id, reason, ...detail,
        });

        // `too_late` is the one skip that means a reminder was LOST rather than
        // handled: its time came and went while nothing was running, and it will
        // not be retried today. Every other reason is a normal outcome — not yet,
        // already answered, already sent — and belongs at debug where it cannot
        // bury anything. This one is what an outage, an overrunning tick or an
        // unset container timezone looks like, and at debug it went unseen.
        //
        // Once per habit per channel per day: the condition holds for the rest of
        // the day, so a per-tick warning would be 1,400 lines about one loss.
        if (reason === 'too_late'
            && once(`late:${account.id ?? 'self'}:${channel}:${habit.id}:${detail.date}`)) {
          log.warn?.('notify.too_late', {
            channel, habit: habit.id, user: account.id, date: detail.date,
            at: detail.at, late_minutes: detail.late_minutes, catch_up: detail.catch_up,
            zone: detail.zone,
          });
        }
      },
    });

    for (const item of due) {
      const payload = {
        habit: item.habit, settings, date: item.date,
        appUrl: ctx.appUrl, botToken: ctx.botToken,
      };
      const startedAt = Date.now();
      let result = await sendToChannel(channel, payload, { fetch: ctx.fetch });

      // Discord's limit is a handful of posts every couple of seconds, so a
      // morning where five habits come due at once can trip it. Honouring the
      // wait it asks for turns that into a delivered reminder; leaving it to
      // the next tick would trip the same limit again a minute later. Once
      // only — a second 429 means something else is wrong.
      let throttled = false;
      if (result.retryAfterMs) {
        throttled = true;
        log.warn?.('notify.throttled', {
          channel, habit: item.habit.id, user: account.id,
          retry_after_ms: result.retryAfterMs,
        });
        await new Promise((r) => setTimeout(r, result.retryAfterMs));
        result = await sendToChannel(channel, payload, { fetch: ctx.fetch });
      }

      if (result.ok) {
        await ctx.mark(account, item.habit.id, channel, item.date);
        sent++;
        // A handful a day per user, and the only positive proof delivery works.
        log.info?.('notify.sent', {
          channel, habit: item.habit.id, user: account.id, date: item.date,
          at: item.time, mode: result.mode, ms: Date.now() - startedAt, throttled,
        });
        continue;
      }

      failed++;
      // A permanent failure is recorded as sent: the reminder is never going
      // to arrive, and retrying it every minute until midnight helps nobody.
      // The settings dialog's test button is how the user finds out.
      if (result.permanent) await ctx.mark(account, item.habit.id, channel, item.date);

      // `permanent` is the field to alert on: it means this reminder is gone and
      // will not be retried, so nobody finds out unless a log says so.
      log.warn?.('notify.failed', {
        channel, habit: item.habit.id, user: account.id, date: item.date,
        permanent: !!result.permanent, status: result.status,
        reason: result.error, ms: Date.now() - startedAt,
      });
    }
  }

  return { sent, failed, skipped };
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
  const startedAt = Date.now();
  const accounts = await ctx.collect(instant);

  let sent = 0;
  let failed = 0;
  let errored = 0;
  const skipped = {};
  for (const account of accounts) {
    try {
      const result = await deliverAccount(account, { ...ctx, instant, log });
      sent += result.sent;
      failed += result.failed;
      for (const [reason, n] of Object.entries(result.skipped ?? {})) {
        skipped[reason] = (skipped[reason] ?? 0) + n;
      }
    } catch (err) {
      // One account's storage error must not stop the others'.
      errored++;
      log.error?.('notify.account_failed', { user: account?.id }, err);
    }
  }

  const ms = Date.now() - startedAt;
  const summary = {
    accounts: accounts.length, sent, failed, errored, ms,
    // Flattened as skip_too_late=1 rather than nested, so it can be graphed and
    // alerted on without a parser that understands one level down.
    ...Object.fromEntries(Object.entries(skipped).map(([r, n]) => [`skip_${r}`, n])),
  };

  // A tick that did nothing is the normal case, once a minute, forever — at info
  // that is 1,440 lines a day saying "no". It goes to debug, and the tick only
  // speaks up when it acted, took too long, or fell behind its own interval.
  const interesting = sent || failed || errored;
  const slow = ctx.intervalMs ? ms > ctx.intervalMs * 0.8 : ms > 30_000;
  if (interesting) log.info?.('notify.tick', summary);
  else log.debug?.('notify.tick', summary);
  if (slow) {
    log.warn?.('notify.tick_slow', {
      ...summary,
      // The next tick is skipped while this one runs, so overrunning does not
      // queue — it silently starves whoever sorts last.
      interval_ms: ctx.intervalMs ?? null,
    });
  }

  // Deliberately no timing here: a caller asserting on this shape would be
  // asserting on the clock. `ms` is a log field, not a result.
  return { accounts: accounts.length, sent, failed, skipped };
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
