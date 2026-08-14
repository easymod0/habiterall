/**
 * Where a reminder goes, and when it is due.
 *
 * Reminders started life as a purely on-device affair: `habits.reminder_time`
 * is a local wall time, and the native Android client turns it into an alarm.
 * That still holds, and it is deliberately the only channel that works with
 * no server and no network.
 *
 * A webhook cannot work that way — nothing on the phone knows about the
 * user's Discord channel, and the browser cannot post to discord.com anyway
 * (the CSP allows `connect-src 'self'` only, and a webhook URL is a secret
 * that has no business in a page). So server-delivered channels need the
 * server to keep time. This module owns the two decisions that requires:
 *
 *   - which destinations a user has enabled, and whether each is configured
 *   - which reminders are due at a given instant, in the user's own zone
 *
 * Everything here is pure: no HTTP, no storage, no clock of its own. The
 * transport lives in notify-send.js and the per-edition wiring in each
 * edition's `notifier.js`.
 */

import { TIME_RE } from './constants.js';
import { isCompleted } from './stats.js';

/** 'YYYY-MM-DD'. Kept local rather than imported from validate.js, which
 *  imports this file for its settings rules. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The notification destinations.
 *
 * `delivery` is the whole reason this registry exists:
 *
 *   'device' — the client schedules it locally. The server does nothing, and
 *              the reminder fires offline. Disabling the channel is a message
 *              to the client, which is why the *client* has to read it.
 *   'server' — the server posts it at the due minute. It needs configuring
 *              before it can do anything, so "enabled" and "ready" are two
 *              different questions — `ready` answers the second.
 *
 * Adding a destination means an entry here, a `send` in notify-send.js, and
 * an option in public/ui/settings.js. `test/notify.test.js` fails if the UI
 * and this list drift apart.
 *
 * @type {Record<string, {
 *   label: string,
 *   delivery: 'device'|'server',
 *   configKeys: string[],
 *   interactive?: boolean,
 *   ready?: (settings: Record<string, any>, ctx: {bot?: boolean}) => boolean,
 * }>}
 */
export const CHANNELS = {
  android: { label: 'Android app', delivery: 'device', configKeys: [], interactive: true },
  discord: {
    label: 'Discord',
    delivery: 'server',
    configKeys: ['discordWebhook', 'discordChannelId'],
    // Buttons only exist in bot mode — Discord accepts `components` on an
    // application-owned webhook only, and a channel webhook is not one.
    interactive: true,
    /**
     * Two ways to reach a channel, and they are not equivalent:
     *
     *   bot   — needs the instance's DISCORD_BOT_TOKEN *and* a channel id, and
     *           can carry Yes / No / Skip buttons and a number-entry modal.
     *   webhook — needs only a URL the user can create themselves, and can
     *           carry text alone.
     *
     * Either is enough to deliver, which is why this is a predicate and not a
     * list of required keys.
     */
    ready: (settings, ctx = {}) => Boolean(
      settings.discordWebhook || (ctx.bot && settings.discordChannelId)
    ),
  },
};

/** Channel ids in registry order, which is also the order the UI lists them. */
export const CHANNEL_IDS = Object.freeze(Object.keys(CHANNELS));

/**
 * Destinations enabled for a new account.
 *
 * The Android app only, because it is the one that needs no configuration —
 * and because a fresh install that silently sent nowhere would look broken.
 */
export const DEFAULT_CHANNELS = Object.freeze(['android']);

/** A pasted webhook URL is ~120 characters; this is generous and bounded. */
export const MAX_WEBHOOK_URL = 200;

/**
 * Hosts a webhook may point at.
 *
 * This is an allowlist rather than a "looks like a URL" check because the
 * SERVER is what fetches it. Without it, `discordWebhook` is a
 * request-forgery primitive: any authenticated user could aim the server at
 * `http://169.254.169.254/`, at a database on the private network, or at a
 * localhost admin port, and use the delivery result as an oracle. Restricting
 * the host means the worst a hostile value can do is post to Discord.
 */
const WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',        // the old domain; still issued in older webhooks
  'ptb.discord.com',
  'canary.discord.com',
]);

/** `/api/webhooks/<id>/<token>`, with or without an explicit API version. */
const WEBHOOK_PATH_RE = /^\/api\/(v\d{1,2}\/)?webhooks\/\d{1,20}\/[\w-]{1,120}$/;

/**
 * Normalise a Discord webhook URL.
 *
 * @param {unknown} raw
 * @returns {string|undefined} the canonical URL, `''` for "not configured",
 *   or `undefined` if the value must be rejected
 */
export function parseDiscordWebhook(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.length > MAX_WEBHOOK_URL) return undefined;

  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (!WEBHOOK_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  if (!WEBHOOK_PATH_RE.test(url.pathname)) return undefined;

  // Rebuilt from the parts we checked rather than returned verbatim: the
  // query string is where `?wait=true`, a `thread_id` for someone else's
  // thread, or simply junk would otherwise survive into a URL the server
  // later fetches.
  return `https://${url.hostname.toLowerCase()}${url.pathname}`;
}

/**
 * Normalise the enabled-channel list.
 *
 * Unknown ids are dropped rather than rejected, so a newer client talking to
 * an older server still gets its known channels saved. Order and duplicates
 * are normalised so the stored value is canonical.
 *
 * @param {unknown} raw
 * @returns {string[]|undefined} `undefined` if the value is not a list at all
 */
export function parseChannelList(raw) {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > CHANNEL_IDS.length * 4) return undefined;   // obvious junk
  return CHANNEL_IDS.filter((id) => raw.includes(id));
}

/**
 * Normalise an IANA time zone name, `''` meaning "use the server's own zone".
 *
 * Validated by asking Intl rather than against a list: the list ships with
 * the runtime's ICU data, so anything Intl accepts is exactly what
 * `zonedClock` can later format. A name this rejects would otherwise throw
 * inside the notifier tick, on a schedule, for one user only.
 *
 * @param {unknown} raw
 * @returns {string|undefined}
 */
export function parseTimeZone(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}

/* ---------- what the user has asked for ---------- */

/**
 * The channels a user has switched on, defaulting for an account that has
 * never touched the setting.
 *
 * @param {Record<string, any>} [settings]
 * @returns {string[]}
 */
export function enabledChannels(settings = {}) {
  const stored = parseChannelList(settings.notifyChannels);
  return stored ?? [...DEFAULT_CHANNELS];
}

/**
 * Whether a channel has everything it needs to actually deliver.
 *
 * `ctx` carries what the *instance* provides rather than the user — today just
 * `bot`, meaning a DISCORD_BOT_TOKEN is configured. Without it a channel id is
 * useless, so the same settings are "ready" on one deployment and not another.
 *
 * `Object.hasOwn`, because `id` can come from a request body and
 * `CHANNELS['__proto__']` is a truthy object with no `configKeys`.
 *
 * @param {string} id
 * @param {Record<string, any>} [settings]
 * @param {{bot?: boolean}} [ctx]
 */
export function channelConfigured(id, settings = {}, ctx = {}) {
  if (!Object.hasOwn(CHANNELS, id)) return false;
  const channel = CHANNELS[id];
  if (channel.ready) return channel.ready(settings, ctx);
  return channel.configKeys.every((key) => String(settings[key] ?? '') !== '');
}

/**
 * Channels this server should deliver for: enabled, server-delivered, and
 * configured. An enabled-but-unconfigured channel is not an error here — the
 * settings dialog is where that gets pointed out.
 *
 * @param {Record<string, any>} [settings]
 * @param {{bot?: boolean}} [ctx]
 * @returns {string[]}
 */
export function serverChannels(settings = {}, ctx = {}) {
  return enabledChannels(settings).filter(
    (id) => CHANNELS[id]?.delivery === 'server' && channelConfigured(id, settings, ctx)
  );
}

/** Whether this account needs the notifier to visit it at all. */
export function needsServerDelivery(settings = {}, ctx = {}) {
  return serverChannels(settings, ctx).length > 0;
}

/**
 * Destinations switched on that can never deliver as things stand.
 *
 * The complement of `serverChannels` within the enabled ones, and it exists
 * because "enabled but not configured" is the one state the notifier handles by
 * doing nothing at all: `needsServerDelivery` is false, the account is skipped,
 * and not a single line above debug level says so. Reminders then never arrive
 * and every visible surface — the settings dialog, the habit, the reminder time
 * — looks correct.
 *
 * The case that motivated it: a channel id and no webhook URL, on an instance
 * with no DISCORD_BOT_TOKEN. That is the recommended setup missing one operator
 * credential, it is silent forever, and the settings dialog's test button says
 * nothing either, because it reports only on channels that ARE ready.
 *
 * @param {Record<string, any>} [settings]
 * @param {{bot?: boolean}} [ctx]
 * @returns {string[]}
 */
export function unreachableChannels(settings = {}, ctx = {}) {
  return enabledChannels(settings).filter(
    (id) => CHANNELS[id]?.delivery === 'server' && !channelConfigured(id, settings, ctx)
  );
}

/**
 * A Discord id (channel, user, message). 17–20 digits, and validated because
 * it is interpolated into a request path.
 *
 * @param {unknown} raw
 * @returns {string|undefined} the id, '' for unset, or undefined to reject
 */
export function parseSnowflake(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return /^\d{17,20}$/.test(value) ? value : undefined;
}

/* ---------- when it is due ---------- */

/**
 * How late a reminder may be and still go out.
 *
 * A reminder is a wall-clock promise, so the honest options for one the
 * server slept through are "send it late" or "drop it". Half an hour is late
 * enough to cover a restart, a slow tick, or a laptop lid, and short enough
 * that nobody is told to meditate at 08:00 while eating lunch. Anything older
 * is dropped rather than queued — waking up after a day of downtime must not
 * fire a day's worth of reminders at once.
 */
export const CATCH_UP_MINUTES = 30;

/** Cached formatters: building one per user per tick is not free. */
const formatters = new Map();

function formatterFor(timeZone) {
  const key = timeZone || '';
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      // 'h23', not `hour12: false`. They differ at exactly one minute of the
      // day: with hour12:false, en-US resolves to the h24 cycle and formats
      // midnight as '24', so a 00:00 reminder would be compared against 1440
      // minutes and never fire — and the local date would still be right,
      // which is what makes it hard to spot.
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    formatters.set(key, fmt);
  }
  return fmt;
}

/**
 * The wall clock in `timeZone` at an instant.
 *
 * The zone matters twice over: it decides which calendar day the reminder is
 * filed under (the key that stops it being sent twice) as well as what time
 * it is. A server in UTC reminding a user in Auckland would otherwise log the
 * send against the wrong day and re-send it hours later.
 *
 * @param {Date|number} instant
 * @param {string} [timeZone] IANA name; '' uses the host zone
 * @returns {{date: string, time: string, minutes: number}}
 */
export function zonedClock(instant, timeZone = '') {
  const parts = /** @type {Record<string, string>} */ ({});
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Minutes since local midnight, or null if this is not an 'HH:MM'. */
export function minutesOfDay(hhmm) {
  if (!TIME_RE.test(String(hhmm ?? ''))) return null;
  const [h, m] = String(hhmm).split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * The habit ids that need no reminder on a day, because they have been
 * answered: either completed, or explicitly skipped.
 *
 * A skip is an ANSWER, not a gap, and that is the whole reason this is not
 * simply "the completed ones". `isCompleted` returns `null` for a skip — "not
 * applicable" — which is falsy, so a truthiness test put every skipped habit
 * back in the queue and asked about a day the user had already dealt with.
 * `!== false` is the distinction: `false` is a real miss and still deserves its
 * reminder, `null` does not.
 *
 * The native client applies the same rule to the same day (`Reminders
 * .needsReminder`), and the two must not disagree — a destination that nags
 * about a skipped day while the other stays quiet reads as one of them being
 * broken.
 *
 * `isCompleted` takes the whole row, never a bare value: a numerical habit
 * recording 3 is an amount, not a skip.
 *
 * @param {import('./types.js').Habit[]} habits
 * @param {{habit_id: number, value: number, status?: string}[]} rows that day's entries
 * @returns {Set<number>}
 */
export function answeredIds(habits, rows) {
  const byId = new Map(habits.map((h) => [h.id, h]));
  const answered = new Set();
  for (const row of rows) {
    const habit = byId.get(row.habit_id);
    if (!habit) continue;
    if (isCompleted(habit, { value: row.value, status: row.status ?? '' }) !== false) {
      answered.add(row.habit_id);
    }
  }
  return answered;
}

/**
 * The reminders due right now for one account.
 *
 * A reminder is due when its local time has arrived, is no more than
 * `catchUpMinutes` old, the habit is not already done for the day, and
 * nothing has been sent for it today. That last check is the account's
 * responsibility to answer — see `alreadySent` — because it is the only part
 * that needs to survive a restart.
 *
 * A reminder whose window straddles local midnight (23:50 with the next tick
 * at 00:05) is dropped rather than re-dated: `late` goes hugely negative, so
 * it fails the window. Sending it under tomorrow's date would both misreport
 * the day and consume tomorrow's slot.
 *
 * @param {object} args
 * @param {import('./types.js').Habit[]} args.habits
 * @param {Date|number} args.instant
 * @param {string} [args.timeZone]
 * @param {(habitId: number, date: string) => boolean} [args.alreadySent]
 * @param {Set<number>} [args.doneToday] answered today — see `answeredIds`
 * @param {number} [args.catchUpMinutes]
 * @param {(habit: import('./types.js').Habit, reason: string, detail: Record<string, any>) => void} [args.onSkip]
 * @returns {{habit: import('./types.js').Habit, date: string, time: string}[]}
 */
export function dueReminders({
  habits,
  instant,
  timeZone = '',
  alreadySent = () => false,
  doneToday = new Set(),
  catchUpMinutes = CATCH_UP_MINUTES,
  onSkip = () => {},
}) {
  const clock = zonedClock(instant, timeZone);
  const due = [];

  /**
   * Every `continue` below reports itself.
   *
   * Six conditions decide this and all six are invisible from outside: a
   * reminder that does not arrive looks exactly like a broken webhook, which
   * sends people to check the thing that is working. `too_late` in particular
   * is unguessable — a time already past on this clock is not late, it is gone
   * until tomorrow — and it is what an unset container timezone produces.
   */
  const skip = (habit, reason, detail) => {
    onSkip(habit, reason, { now: clock.time, date: clock.date, zone: timeZone || 'system', ...detail });
    return undefined;
  };

  for (const habit of habits) {
    if (habit.archived) { skip(habit, 'archived'); continue; }

    const at = minutesOfDay(habit.reminder_time);
    if (at === null) { skip(habit, 'no_reminder_time'); continue; }   // '' — none set

    const late = clock.minutes - at;
    if (late < 0) { skip(habit, 'not_yet', { at: habit.reminder_time, in_minutes: -late }); continue; }
    if (late > catchUpMinutes) {
      skip(habit, 'too_late', { at: habit.reminder_time, late_minutes: late, catch_up: catchUpMinutes });
      continue;
    }

    if (doneToday.has(habit.id)) { skip(habit, 'done_today'); continue; }
    if (alreadySent(habit.id, clock.date)) { skip(habit, 'already_sent'); continue; }

    due.push({ habit, date: clock.date, time: habit.reminder_time });
  }

  return due;
}

/* ---------- what it says ---------- */

/** 'at least 8 glasses', 'at most 2 cigarettes', or '' for a yes/no habit. */
function goalText(habit) {
  if (habit.type !== 'numerical') return '';
  const qualifier = habit.target_type === 'at_most' ? 'at most' : 'at least';
  const amount = Number(habit.target_value ?? 0);
  // Targets are NOT scaled by 1000 — only entry values are. A target of 2
  // means 2. Dividing here once turned "at most 2" into "at most 0.002".
  const unit = String(habit.unit ?? '').trim();
  return `${qualifier} ${amount}${unit ? ` ${unit}` : ''}`;
}

/**
 * The text of a reminder, shared by every server-delivered channel so they
 * cannot describe the same habit differently.
 *
 * `reminder_message` is the whole point of the title: 'Did you exercise today?'
 * is a question, where the habit's name and a generated sentence are a label
 * and a form. The habit name still appears — as the subtitle — because a
 * channel carrying several habits needs to say which one is asking.
 *
 * @param {import('./types.js').Habit} habit
 * @param {{test?: boolean}} [opts]
 * @returns {{title: string, subtitle: string, body: string}}
 */
export function reminderMessage(habit, { test = false } = {}) {
  const name = String(habit.name ?? 'Habit');
  const custom = String(habit.reminder_message ?? '').trim();
  const goal = goalText(habit);

  const generated = goal
    ? `Time to log this one — goal: ${goal}.`
    : 'Time to check in — have you done this today?';

  if (test) {
    return {
      title: custom || name,
      subtitle: name,
      body: 'Test notification from habiterall. Buttons here record nothing.',
    };
  }

  // With a prompt, it leads and the generated sentence is dropped — repeating
  // "have you done this today?" under "Did you exercise today?" is noise.
  // Without one, the name leads exactly as before.
  return custom
    ? { title: custom, subtitle: name, body: goal ? `Goal: ${goal}.` : '' }
    : { title: name, subtitle: '', body: generated };
}

/* ---------- answering from the notification ---------- */

/**
 * What a button can do.
 *
 * 'amount' is not a value — it opens a box to type one, because a button
 * cannot collect "6 glasses". Everything else records immediately.
 */
export const ACTIONS = Object.freeze(['yes', 'no', 'skip', 'amount']);

/** Namespace for our own component ids, so anything else is ignored. */
const ACTION_PREFIX = 'hab';
/** A test message's buttons: same shapes, but they record nothing. */
const TEST_PREFIX = 'test';

/**
 * Pack what a button means into Discord's 100-character `custom_id`.
 *
 * The id is the ONLY thing that comes back with a click, so it has to carry
 * the habit and the day. It is not trusted on the way back in: the account is
 * resolved from the channel the click came from, and the habit is then looked
 * up within that account — see `handleInteraction` in discord.js.
 */
export function encodeAction({ habitId, date, action, test = false }) {
  return test
    ? `${TEST_PREFIX}|${action}`
    : `${ACTION_PREFIX}|${habitId}|${date}|${action}`;
}

/**
 * Read a `custom_id` back.
 *
 * @returns {{test: boolean, habitId: number, date: string, action: string}|null}
 *   null for anything not ours, or malformed
 */
export function parseAction(customId) {
  const parts = String(customId ?? '').split('|');

  if (parts[0] === TEST_PREFIX) {
    if (!ACTIONS.includes(parts[1])) return null;
    return { test: true, habitId: 0, date: '', action: parts[1] };
  }

  if (parts[0] !== ACTION_PREFIX || parts.length !== 4) return null;
  const habitId = Number(parts[1]);
  if (!Number.isInteger(habitId) || habitId <= 0) return null;
  if (!DATE_RE.test(parts[2])) return null;
  if (!ACTIONS.includes(parts[3])) return null;

  return { test: false, habitId, date: parts[2], action: parts[3] };
}

/** Discord button styles, by name rather than by magic number. */
const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };

/**
 * The buttons under a reminder.
 *
 * A yes/no habit gets Yes / No / Skip. A measurable one gets "Enter amount",
 * which opens a modal — there is no button that can mean "6". Skip is offered
 * on both, because "not applicable today" is a distinct answer from either.
 *
 * Returns `[]` when there is nothing to attach, so a webhook send (which
 * cannot carry components at all) simply gets an empty list.
 *
 * @param {import('./types.js').Habit} habit
 * @param {{date?: string, test?: boolean}} [opts]
 */
export function reminderComponents(habit, { date = '', test = false } = {}) {
  const id = (action) => encodeAction({ habitId: habit.id, date, action, test });

  const buttons = habit.type === 'numerical'
    ? [
      { type: 2, style: STYLE.primary, label: 'Enter amount', custom_id: id('amount') },
      { type: 2, style: STYLE.secondary, label: 'Skip', custom_id: id('skip') },
    ]
    : [
      { type: 2, style: STYLE.success, label: 'Yes', custom_id: id('yes') },
      { type: 2, style: STYLE.secondary, label: 'No', custom_id: id('no') },
      { type: 2, style: STYLE.secondary, label: 'Skip', custom_id: id('skip') },
    ];

  return [{ type: 1, components: buttons }];
}

/**
 * How an answer reads once it has been recorded, so the message can say what
 * happened rather than just losing its buttons.
 *
 * @param {import('./types.js').Habit} habit
 * @param {{action: string, value?: number}} answer
 */
export function answerText(habit, { action, value }) {
  if (action === 'skip') return 'Skipped';
  if (action === 'no') return 'Not done';
  if (action === 'yes') return 'Done';

  const unit = String(habit.unit ?? '').trim();
  return `${value}${unit ? ` ${unit}` : ''}`;
}

/** '#3b82f6' as the integer Discord wants, falling back to its blurple. */
function colorInt(color) {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(String(color ?? ''));
  return hex ? parseInt(hex[1], 16) : 0x5865f2;
}

/**
 * The body of a Discord webhook POST.
 *
 * @param {object} args
 * @param {import('./types.js').Habit} args.habit
 * @param {{title: string, subtitle?: string, body: string}} args.message
 * @param {string} [args.date] local date the reminder is for
 * @param {string} [args.appUrl] public URL of this habiterall, if known
 */
export function discordPayload({ habit, message, date = '', appUrl = '' }) {
  const embed = {
    title: message.title.slice(0, 256),
    color: colorInt(habit.color),
  };

  // The habit's name, when the title is a custom prompt that does not contain
  // it. `author` rather than another line of description: it renders small and
  // above the title, which is exactly the weight "which habit is this" wants.
  if (message.subtitle) embed.author = { name: message.subtitle.slice(0, 256) };
  if (message.body) embed.description = message.body.slice(0, 2000);

  const description = String(habit.description ?? '').trim();
  if (description) {
    embed.fields = [{ name: 'Notes', value: description.slice(0, 1024) }];
  }
  if (date) embed.footer = { text: date };
  // Makes the embed title a link into the app. Only when the deployment has
  // told us its own address — guessing one would produce a dead link.
  if (/^https?:\/\//.test(appUrl)) embed.url = appUrl.replace(/\/+$/, '') + '/';

  return {
    username: 'habiterall',
    embeds: [embed],
    // A habit may be called anything, including '@everyone'. Embeds do not
    // resolve mentions today, but this is the guarantee rather than a
    // side-effect of where the text happens to sit.
    allowed_mentions: { parse: [] },
  };
}
