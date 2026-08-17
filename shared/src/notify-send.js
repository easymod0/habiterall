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
 *   collect() -> [{ id, settings, habits, doneToday, alreadySent, delivered }]
 *   mark(account, habitId, channel, date)
 *   recordOutcome(account, channel, outcome)
 *
 * `collect` reads storage, `mark` writes the watermark that stops a reminder
 * being sent twice, and `recordOutcome` writes the one thing a *user* can see
 * about all this — whether their last reminder actually arrived. Everything
 * between them is here.
 */

import {
  CHANNELS, dueReminders, discordPayload, isNtfyToken, ntfyPayload, ntfyTarget,
  reminderMessage, resolveTimeZone, serverChannels, takeUnusableZones,
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
 * What a destination's recorded state amounts to, for "is this news?".
 *
 * Everything the settings dialog puts in front of the user, and nothing that
 * moves on its own — see `noteOutcome`.
 *
 * @param {{ok?: boolean, status?: number, error?: string, permanent?: boolean}} [o]
 */
function stateKey(o) {
  if (!o) return '';
  return [o.ok ? 'ok' : 'no', o.permanent ? 'permanent' : '', o.status ?? '', o.error ?? '']
    .join('|');
}

/**
 * One user's world, as a tick needs it: read once, up front, so no storage is
 * touched while a webhook is in flight.
 *
 * @typedef {object} NotifyAccount
 * @property {number|null} [id] for the log; the personal edition has none
 * @property {Record<string, any>} [settings]
 * @property {import('./types.js').Habit[]} [habits] those with a reminder time
 * @property {string} [timeZone] the clock this account is on, already resolved
 *   by `collect` through `resolveTimeZone`. Carried rather than re-derived,
 *   because deciding it twice is how the two answers came to differ.
 * @property {Set<number>} [doneToday]
 * @property {(habitId: number, channel: string, date: string) => boolean} [alreadySent]
 * @property {Record<string, DeliveryOutcome>} [delivered] channel -> the outcome
 *   currently stored for it. Absent means nothing has been recorded for that
 *   channel yet. Only used to decide whether a new outcome is NEWS, so it needs
 *   the REASON and not just `ok` — see `noteOutcome`.
 */

/**
 * What is worth remembering about a delivery attempt, once it differs from the
 * last one. `error` is the prose the sender already produced — re-inventing it
 * in the UI is how the two would come to say different things about one 404.
 *
 * @typedef {object} DeliveryOutcome
 * @property {boolean} ok
 * @property {number} [status]
 * @property {string} [error]
 * @property {boolean} [permanent]
 * @property {'bot'|'webhook'} [mode]
 * @property {string} [date] the local date the reminder was for
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
 * @property {(account: NotifyAccount, channel: string, outcome: DeliveryOutcome) => any} [recordOutcome]
 *   Store the last delivery outcome for a destination, so the settings dialog
 *   can say a reminder failed. Called only when the outcome DIFFERS from what
 *   is stored, which turns "a write per reminder per channel" into "a write
 *   when something changes".
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
 * Publish one reminder to an ntfy topic.
 *
 * Its own function rather than `postWebhook` with another URL, and the wording
 * is why: `notify_status` shows the SENDER's sentence in the settings dialog,
 * so "the webhook was deleted or is no longer accepted — create a new one" said
 * about ntfy would be advice for a thing the user does not have. Every string
 * below is what the user will read when their reminders stop.
 *
 * @param {object} args
 * @param {import('./types.js').Habit} args.habit
 * @param {Record<string, any>} args.settings
 * @param {string} [args.date]
 * @param {string} [args.appUrl]
 * @param {boolean} [args.test]
 * @param {{fetch?: typeof globalThis.fetch, timeoutMs?: number,
 *   env?: Record<string, string|undefined>}} [deps]
 * @returns {Promise<SendResult>}
 */
export async function postNtfy(args, deps = {}) {
  const { habit, settings, date = '', appUrl = '', test = false } = args;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS;

  // Asked again HERE, and not only when the value was stored. `parseNtfyUrl`
  // reads the operator's allowlist, and an operator can narrow it long after a
  // user has saved a URL — so the check that decides what this process connects
  // to belongs at the moment it connects. Permanent, because nothing about
  // this changes until somebody edits a setting or the environment: retrying
  // every minute until midnight would be a minute-by-minute request at a host
  // this instance has been told not to talk to.
  const target = ntfyTarget(settings.ntfyTopicUrl, deps.env);
  if (!target) {
    return {
      ok: false,
      status: 0,
      permanent: true,
      error: 'this topic URL is not one this server may post to — it must be '
        + 'https and on a host named in NTFY_ALLOWED_HOSTS',
    };
  }

  const token = String(settings.ntfyToken ?? '');
  // A token reaches an `Authorization` header, so a value that could not go in
  // one is refused rather than trimmed into something that could. Nothing that
  // came through `parseNtfyToken` can fail this; a hand-edited settings row can.
  if (token && !isNtfyToken(token)) {
    return {
      ok: false,
      status: 0,
      permanent: true,
      error: 'the ntfy access token has characters that cannot go in a request header',
    };
  }

  const message = reminderMessage(habit, { test });
  const payload = ntfyPayload({ habit, message, topic: target.topic, date, appUrl });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await doFetch(target.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // As the Discord sender does, and for a sharper reason: a redirect is
      // how an allowed host walks this request onto one that is not, and the
      // token would go with it.
      redirect: 'manual',
    });

    if (res.status === 429) {
      const seconds = Number(res.headers?.get?.('retry-after'));
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 1;
      return { ok: false, status: 429, error: 'rate limited by the ntfy server', retryAfterMs: wait * 1000 };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        permanent: true,
        error: 'ntfy refused the request — this topic needs an access token, or '
          + 'the one saved here is no longer valid',
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        permanent: true,
        error: 'the ntfy server has nothing at that address — check the topic URL',
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, error: `ntfy returned ${res.status}` };
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
        // The account's own setting decides whether a Skip button is offered, so
        // the shade, the grid and the channel agree about what answers exist.
        skipDays: settings.skipDays === true,
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

  if (channel === 'ntfy') {
    return postNtfy({ habit, settings, date, appUrl, test }, deps);
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

  // What is currently recorded for each channel, so only a CHANGE is written.
  // Seeded from storage and then kept up to date in memory, or five habits
  // failing at 08:00 would be five identical writes — and the second through
  // fifth say nothing the first did not.
  const recorded = { ...(account.delivered ?? {}) };

  /**
   * Remember an outcome if it is news.
   *
   * News is a change of STATE — and the state is not just "did it work". A
   * 500 on Monday and a deleted webhook on Tuesday are both `ok: false`, so
   * comparing that alone froze the reason at whichever failure came first: the
   * user would be shown "webhook returned 500" forever while the actionable
   * "create a new one" never arrived. Which is a softer version of the exact
   * silence this whole feature exists to end, so the reason is part of the key.
   *
   * `date` deliberately is NOT. It moves every day a failure persists, and
   * including it would make this a write per reminder again — so what is stored
   * is the date this state BEGAN, which is what "not delivered since" reads
   * from.
   */
  const noteOutcome = async (channel, result, date) => {
    if (!ctx.recordOutcome) return;
    if (stateKey(recorded[channel]) === stateKey(result)) return;
    recorded[channel] = result;
    try {
      await ctx.recordOutcome(account, channel, {
        ok: result.ok,
        status: result.status,
        error: result.error,
        permanent: !!result.permanent,
        mode: result.mode,
        date,
      });
    } catch (err) {
      log.error?.('notify.outcome_not_stored', { channel, user: account.id }, err);
    }
  };

  /**
   * Write the watermark, and survive a storage failure.
   *
   * This was the one storage call in the loop with nothing around it, next to a
   * `noteOutcome` that has had a try/catch since it was written — and it is the
   * call most likely to fail on the cloud side, where `mark` opens its own pool
   * connection per habit, so pool exhaustion reaches it. An exception here
   * unwound `deliverAccount` entirely: the habit whose reminder had JUST BEEN
   * DELIVERED took the remaining due habits down with it, unattempted, and the
   * tick reported `sent: 0` about a message the user was looking at.
   *
   * Reported at error, because the consequence outlives the tick: with no
   * watermark the next minute re-sends the same reminder, for the whole
   * catch-up window. That is worth a line each time rather than a deduped one —
   * a healthy instance writes here never.
   *
   * @returns {Promise<boolean>} whether the watermark is stored
   */
  const mark = async (habitId, channel, date) => {
    try {
      await ctx.mark(account, habitId, channel, date);
      return true;
    } catch (err) {
      log.error?.('notify.watermark_not_stored',
        { channel, habit: habitId, user: account.id, date }, err);
      return false;
    }
  };

  for (const channel of channels) {
    const due = dueReminders({
      habits: account.habits ?? [],
      instant: ctx.instant,
      // The zone `collect` already resolved, NOT `settings.notifyTimezone`.
      // Reading the setting here was a SECOND place the clock was decided, and
      // the two answers stopped agreeing the moment `auto` existed: `collect`
      // resolved it to the device's zone for `doneToday` and `alreadySent`,
      // while this passed the literal string `auto` to `dueReminders` — which
      // fell back to the server's clock, so every reminder for an account
      // following its device was judged against the wrong day and reported
      // `too_late`. Resolved once, in `resolveTimeZone`, and carried.
      timeZone: account.timeZone ?? resolveTimeZone(settings),
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
        await mark(item.habit.id, channel, item.date);
        // A success is worth storing for one reason: it CLEARS a failure the
        // user is being shown. Nothing changed, nothing is written.
        await noteOutcome(channel, result, item.date);
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
      if (result.permanent) await mark(item.habit.id, channel, item.date);

      // ...and this is how the user finds out, rather than by pressing a test
      // button nothing suggests pressing. A deleted webhook or a bot removed
      // from the channel used to stop reminders while every visible surface —
      // the habit, its time, the destination toggle — went on looking correct,
      // and the only record was a warn line a cloud user cannot read and an
      // operator has no reason to look for.
      await noteOutcome(channel, result, item.date);

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

  // A `collect` that throws outright ends the tick — there is nothing to
  // deliver — but it is named here rather than left to `startNotifier`'s
  // printf, which is the least greppable line in the file and the only one a
  // total read failure ever produced. Every other outcome in this module is a
  // `notify.*` event; this one was not.
  let accounts;
  try {
    accounts = await ctx.collect(instant);
  } catch (err) {
    log.error?.('notify.collect_failed', { ms: Date.now() - startedAt }, err);
    return { accounts: 0, sent: 0, failed: 0, skipped: {} };
  }

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

  // A zone `Intl` would not take falls back to the server's clock rather than
  // ending the tick — but silently, it means an account gets every reminder on
  // the wrong clock forever with nothing to say so. Drained once per tick and
  // deduped, because it is a configuration rather than an event: it stays wrong
  // until somebody fixes the value.
  for (const zone of takeUnusableZones()) {
    if (!once(`unusable_zone:${zone}`)) continue;
    log.warn?.('notify.zone_unusable', {
      zone,
      reason: 'Intl does not know this zone — reminders for accounts using it '
        + "are on the server's clock",
    });
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
