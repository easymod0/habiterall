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
 *   'device' — the client decides locally. The server does nothing, and the
 *              destination works offline. Disabling the channel is a message
 *              to the client, which is why the *client* has to read it.
 *   'server' — the server posts it at the due minute. It needs configuring
 *              before it can do anything, so "enabled" and "ready" are two
 *              different questions — `ready` answers the second.
 *
 * 'device' says who DECIDES, not that a time is kept. `android` arms an alarm
 * and fires at 08:00; `web` cannot, because no browser API will wake a page at
 * a given minute — see the `web` entry. They are the same kind here because the
 * only thing this word decides is whether the SERVER has anything to do, and
 * for both of them it has nothing.
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
  web: {
    label: 'This browser',
    // 'device', and the server must be able to see that at a glance: nothing
    // here is scheduled, sent or logged by it. `serverChannels` filters on this
    // word, so the notifier skips an account that has switched this on and
    // nothing else — which is right, because there is nothing for it to do.
    delivery: 'device',
    // Nothing to configure, and deliberately nothing the server could be given.
    // What this destination needs is a PERMISSION, which belongs to one browser
    // and cannot be stored on an account: two machines signed into the same
    // account have two different answers, and only the machine can be asked.
    // So `channelConfigured` says yes for everybody and the settings dialog
    // reports the permission itself — see `browserNudgeProblems` in
    // public/ui/settings.js.
    configKeys: [],
    /**
     * NOT interactive, and unlike ntfy's that is the platform rather than a
     * decision with a security question behind it.
     *
     * `interactive` means a destination can carry buttons that RECORD an
     * answer, which needs a handler running where the press lands — Discord's
     * gateway socket, or the phone's `ActionReceiver`. A page-level
     * `Notification` has a click and nothing else, and the click focuses the
     * tab; the tab IS the app, so the answer is given in the app. Notification
     * ACTIONS do exist, and they need a service worker `notificationclick`
     * handler — which arrives with the web push that would justify it, in
     * issue #70's part 2, and not before.
     */
    interactive: false,
  },
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
  ntfy: {
    label: 'ntfy',
    delivery: 'server',
    // A topic URL is the whole configuration. The token is optional — a public
    // topic needs none — so it is not a config key and its absence is not a
    // reason to call this destination unconfigured.
    configKeys: ['ntfyTopicUrl'],
    /**
     * NOT interactive, and that is a decision rather than a gap.
     *
     * ntfy can carry action buttons, and an ntfy action is an HTTP request the
     * SUBSCRIBING DEVICE makes — to a URL written into the notification, from
     * wherever that phone happens to be, carrying whatever the message told it
     * to carry. Answering a reminder that way means this server standing up an
     * inbound endpoint that anything able to reach it may call, authorised by
     * nothing but the contents of the request. That is precisely the shape
     * `discord-gateway.js` exists to avoid — a self-hosted instance behind a
     * router has no inbound port and no hostname — and the rule that saves the
     * Discord buttons has no counterpart here: "a press is authorised by the
     * CHANNEL it came from, not by its `custom_id`" needs a channel to resolve
     * an account from, and an ntfy topic is a URL somebody typed.
     *
     * So this destination TELLS you and the app is where you answer. Making it
     * interactive is a separate decision with a real authorisation question
     * attached, and the paragraph above is the one to re-read first.
     */
    interactive: false,
  },
};

/** Channel ids in registry order, which is also the order the UI lists them. */
export const CHANNEL_IDS = Object.freeze(Object.keys(CHANNELS));

/**
 * Destinations enabled for a new account.
 *
 * The Android app only, because it is the one that needs no configuration —
 * and because a fresh install that silently sent nowhere would look broken.
 *
 * `web` needs no configuration either and is still not here, because it needs
 * something the account cannot hold: this browser's permission to raise a
 * notification. Switching it on is what asks for that, from inside the click
 * that did it — a prompt nobody invited is what browsers now refuse outright,
 * and an account arriving with a destination it has never been able to use is
 * the same silence in a different place.
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

/* ---------- ntfy ---------- */

/** A topic URL is `https://host/topic`; this is generous and bounded. */
export const MAX_NTFY_URL = 200;

/**
 * Where an ntfy topic may live, when the operator has named nowhere.
 *
 * The public service, because it is the one host that is universally reachable
 * and is nobody's private network. An operator who runs their own ntfy names it
 * in `NTFY_ALLOWED_HOSTS`, which REPLACES this rather than adding to it — so
 * "only my own ntfy" is expressible, and so is "none at all" (`off`).
 */
const NTFY_DEFAULT_HOSTS = 'ntfy.sh';

/**
 * One path segment. No dots at all, which is what makes `..`, `.` and every
 * encoded spelling of them unrepresentable rather than filtered.
 */
const NTFY_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A host in an allowlist entry: a name, optionally with a port.
 *
 * Strict rather than "whatever is left of the first slash", because this is
 * where an operator's typo has to fail CLOSED. `*`, `*.example.com`,
 * `.example.com`, `https://ntfy.sh` and an empty entry all fail it and are
 * dropped, so a wildcard nobody implemented cannot read as one that works. An
 * IP literal passes, deliberately: naming one is a thing an operator may mean.
 */
const NTFY_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** How deep a base path an entry may name. Four is already generous. */
const MAX_NTFY_BASE_SEGMENTS = 4;

/**
 * One allowlist entry, canonicalised, or `null` if it is not usable.
 *
 * An entry is a host and OPTIONALLY a base path: `ntfy.sh`,
 * `ntfy.example.com:8443`, `example.com/ntfy`. Both halves are lowercased and
 * empty segments are dropped, so `Example.COM/ntfy/` and `example.com//ntfy`
 * are the same entry — and the canonical form is what a URL is later compared
 * against, whole segment by whole segment.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function ntfyEntry(raw) {
  const parts = raw.trim().toLowerCase().split('/');
  const host = parts.shift() ?? '';
  if (!NTFY_HOST_RE.test(host)) return null;

  const base = parts.filter(Boolean);
  if (base.length > MAX_NTFY_BASE_SEGMENTS) return null;
  if (!base.every((segment) => NTFY_SEGMENT_RE.test(segment))) return null;

  return base.length ? `${host}/${base.join('/')}` : host;
}

/**
 * Where this instance is willing to post an ntfy message.
 *
 * An OPERATOR decision, read from the environment, and that is the whole shape
 * of the difference from `parseDiscordWebhook`. That one can allowlist Discord's
 * four hosts in this file because there is exactly one Discord; the entire point
 * of ntfy is that most people run their own, so there is no host list anybody
 * here could write. What there IS, on both editions, is somebody who runs the
 * server and somebody who types the URL — and on the cloud edition they are not
 * the same person. Whose network the server may be aimed at is the first one's
 * question, so it is answered where they answer things.
 *
 * **An entry names a host and optionally a BASE PATH**, and the second half is
 * the correction that makes this equivalent to the Discord rule rather than
 * merely similar to it. `parseDiscordWebhook` pins the path exactly, so
 * allowlisting `discord.com` allows one KIND of request. Allowing any shallow
 * path on a host does not: with the reverse-proxy deployment our own docs
 * recommend, `https://example.com/internal/admin/reset/x` was a JSON POST to
 * `https://example.com/internal/admin/reset/` with a chosen title, a chosen
 * body, a chosen bearer token and the response status handed back to the user
 * — a path and service enumeration oracle, on demand, for any account. So the
 * operator names the base and a user may append exactly ONE topic segment to
 * it. `ntfy.sh` (the default) therefore permits `https://ntfy.sh/<topic>` and
 * nothing deeper.
 *
 * That depth is **one and not configurable** on purpose: the topic is the only
 * part of the URL the operator cannot know in advance, and every extra segment
 * they cannot name is another path on their network this becomes able to POST
 * to. A deployment that needs more says so by naming more base — which is the
 * same decision, made where the other operator decisions are.
 *
 * DNS rebinding needs no answer here, and this is why: an allowlist entry is a
 * name the OPERATOR chose, so an attacker cannot introduce a hostname whose
 * resolution they control. The gap between checking the name and connecting to
 * it is therefore not reachable, and pinning an IP would buy nothing while
 * breaking every ntfy behind a load balancer.
 *
 * `off` is an empty set: every URL refused, which is how an operator switches
 * the destination off for a whole instance without it disappearing from the
 * settings dialog and looking broken — the refusal says why.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Set<string>} canonical `host` / `host/base/path` entries
 */
export function ntfyAllowlist(env = globalThis.process?.env ?? {}) {
  const raw = String(env.NTFY_ALLOWED_HOSTS ?? '').trim();
  if (raw.toLowerCase() === 'off') return new Set();
  const entries = (raw || NTFY_DEFAULT_HOSTS).split(',')
    .map(ntfyEntry)
    .filter((entry) => entry !== null);
  return new Set(/** @type {string[]} */ (entries));
}

/**
 * Entries of `NTFY_ALLOWED_HOSTS` this could make nothing of.
 *
 * Dropping them is right — a wildcard nobody implemented must not read as one
 * that works — but doing it in silence means the only surface for the typo is a
 * user's URL snapping back to blank in the settings dialog, which reads as an
 * app bug and is reported as one. `runTick` says it once per process.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]} the entries as the operator wrote them
 */
export function ntfyAllowlistProblems(env = globalThis.process?.env ?? {}) {
  const raw = String(env.NTFY_ALLOWED_HOSTS ?? '').trim();
  if (!raw || raw.toLowerCase() === 'off') return [];
  return raw.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && ntfyEntry(entry) === null);
}

/**
 * An ntfy access token, bounded and safe to put in a header.
 *
 * Printable ASCII with no spaces, so nothing here can carry a `\r\n` and split
 * the request — the same trap the Loop export's `X-Habiterall-Export-Skipped`
 * records, with a nastier sink: this value goes into an `Authorization` header
 * on a request the SERVER makes.
 */
const NTFY_TOKEN_RE = /^[\x21-\x7e]{1,128}$/;

/**
 * Normalise an ntfy topic URL.
 *
 * The server fetches this, so it is a request-forgery primitive and the
 * reasoning is `parseDiscordWebhook`'s. What could not be copied is its host
 * list — see `ntfyAllowlist` — so the rest of the check carries more weight
 * than it does there, and every part of it is load bearing:
 *
 *   - **https only.** Plain http is refused even for a host the operator has
 *     allowed: a reminder carries a habit's name and prompt, and an ntfy token
 *     would ride on the same request in clear.
 *   - **no credentials**, because `https://ntfy.sh@evil.example/x` has a host
 *     of `evil.example` and reads as the opposite to a person.
 *   - **the host, WITH its port**, matched WHOLE against the operator's list.
 *     Never a suffix test: `evilntfy.sh` ends with `ntfy.sh`.
 *   - **the base path the operator named, and exactly one topic segment after
 *     it.** Compared segment by segment and never as a string prefix, or
 *     `example.com/ntfy` would also allow `/ntfyadmin`.
 *   - **rebuilt from the parts that were checked**, exactly as the Discord one
 *     is — and from the ENTRY's spelling of the base path rather than the
 *     caller's, so what is fetched is the path the operator named and the
 *     caller's casing decides nothing but the topic's.
 *
 * And `postNtfy` asks again at the moment of sending, because this answer
 * depends on the environment and the environment can change under a value that
 * is already stored.
 *
 * @param {unknown} raw
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined} the canonical URL, `''` for "not configured",
 *   or `undefined` if the value must be rejected
 */
export function parseNtfyUrl(raw, env = globalThis.process?.env ?? {}) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.length > MAX_NTFY_URL) return undefined;

  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;

  const host = url.host.toLowerCase();

  // One trailing slash is forgiven — it is what people paste. Everything else
  // has to be a segment we recognise: an empty one (`//`), a dot, a percent
  // escape or anything outside the pattern ends it here rather than being
  // normalised into something that passes.
  const segments = url.pathname.replace(/\/$/, '').split('/');
  if (segments.shift() !== '') return undefined;             // pathname starts with /
  if (segments.length > MAX_NTFY_BASE_SEGMENTS + 1) return undefined;
  if (!segments.length) return undefined;                    // names no topic at all
  if (!segments.every((segment) => NTFY_SEGMENT_RE.test(segment))) return undefined;

  // The last segment is the topic — the one part of the URL the operator cannot
  // know in advance — and everything before it must BE an entry, not merely
  // start with one. `Set.has` on the joined base is the whole-segment
  // comparison: `example.com/ntfyadmin` is a different key from
  // `example.com/ntfy`, where a `startsWith` would have let it through.
  const topic = /** @type {string} */ (segments.pop());
  const base = segments.map((segment) => segment.toLowerCase()).join('/');
  if (!ntfyAllowlist(env).has(base ? `${host}/${base}` : host)) return undefined;

  return `https://${host}${base ? `/${base}` : ''}/${topic}`;
}

/**
 * An ntfy access token, or `''` for a public topic.
 *
 * @param {unknown} raw
 * @returns {string|undefined}
 */
export function parseNtfyToken(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return NTFY_TOKEN_RE.test(value) ? value : undefined;
}

/** Whether a token is one that can be put in a header at all. */
export function isNtfyToken(value) {
  return NTFY_TOKEN_RE.test(String(value ?? ''));
}

/**
 * Split a stored topic URL into the endpoint to post to and the topic to name.
 *
 * ntfy publishes JSON to the SERVER root with `{topic, ...}` in the body, not
 * to the topic URL — posting JSON there would file the raw JSON as the message
 * text. The alternative shape, POSTing to the topic URL with `Title` and
 * friends as headers, is what this deliberately avoids: a habit's name is free
 * text, and free text in a header is a request-splitting bug waiting for
 * somebody to name a habit with a newline in it.
 *
 * Re-validates rather than trusting the stored string, because
 * `NTFY_ALLOWED_HOSTS` is the operator's and can be narrowed after a user has
 * saved a URL — and it re-validates the whole rule, base path included, not
 * merely the host. `null` means "do not send this". The endpoint this returns
 * is therefore always a base the operator named, never one a caller composed.
 *
 * @param {unknown} raw
 * @param {Record<string, string|undefined>} [env]
 * @returns {{endpoint: string, topic: string}|null}
 */
export function ntfyTarget(raw, env = globalThis.process?.env ?? {}) {
  const clean = parseNtfyUrl(raw, env);
  if (!clean) return null;

  const url = new URL(clean);
  const parts = url.pathname.split('/').filter(Boolean);
  const topic = /** @type {string} */ (parts.pop());
  const base = parts.length ? `/${parts.join('/')}/` : '/';
  return { endpoint: `https://${url.host}${base}`, topic };
}

/**
 * The body of an ntfy publish.
 *
 * Everything the Discord embed carries, flattened: ntfy has a title and a
 * message and no fields, so the habit name, the goal and the description become
 * lines rather than being dropped.
 *
 * @param {object} args
 * @param {import('./types.js').Habit} args.habit
 * @param {{title: string, subtitle?: string, body: string}} args.message
 * @param {string} args.topic
 * @param {string} [args.date] local date the reminder is for
 * @param {string} [args.appUrl] public URL of this habiterall, if known
 */
export function ntfyPayload({ habit, message, topic, date = '', appUrl = '' }) {
  const lines = [];
  if (message.subtitle) lines.push(message.subtitle);
  if (message.body) lines.push(message.body);

  const description = String(habit.description ?? '').trim();
  if (description) lines.push(description);
  if (date) lines.push(date);

  const payload = {
    topic,
    title: message.title.slice(0, 250),
    // ntfy substitutes a placeholder for an empty message, so a habit with a
    // custom prompt and no goal still says something under its own title.
    message: (lines.join('\n') || message.title).slice(0, 4000),
  };

  // Tapping the notification opens the app, when the deployment has told us
  // where it is. Counted off rather than matched with `/\/+$/`, for the reason
  // `discordPayload` gives: that pattern is quadratic on a string of slashes.
  if (/^https?:\/\//.test(appUrl)) {
    let end = appUrl.length;
    while (end > 0 && appUrl[end - 1] === '/') end--;
    payload.click = `${appUrl.slice(0, end)}/`;
  }

  return payload;
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
 * "Follow whichever device the account last used", the default.
 *
 * A real stored value rather than the absence of one, for the reason
 * `theme: 'system'` and `at_most_unlogged: 'default'` are: an OBSERVATION and a
 * DECISION must stay tellable apart. Write the detected zone into
 * `notifyTimezone` itself and the first client to check in turns "automatic"
 * into a chosen value, after which there is no way back to automatic and a
 * stale detection outlives the trip that caused it.
 *
 * `''` keeps its old meaning — the server's own clock, chosen deliberately —
 * so an account that picked it keeps it, and one that has never touched the
 * setting gets `auto` from the default. Nothing to migrate: `applyDraft` only
 * writes keys that CHANGED, and `''` was the previous default, so almost no
 * account has it on disk.
 */
export const AUTO_ZONE = 'auto';

/**
 * The header a client uses to say which clock it is on.
 *
 * A header on traffic that already exists rather than a call of its own: the
 * point of `auto` is that following your zone costs no extra request. Both
 * clients set it at their single request chokepoint — `ui/api.js` and
 * `Api.kt` — and the server writes only when the value CHANGES, which for a
 * settled account is never.
 */
export const DEVICE_ZONE_HEADER = 'X-Habiterall-Timezone';

/**
 * The zone a client just reported, or '' if it did not report a usable one.
 *
 * `auto` is refused explicitly: it is the SETTING's word for "ask the device",
 * so a client echoing it back would be an account asking itself.
 *
 * @param {unknown} raw the header value
 */
export function reportedZone(raw) {
  const value = parseTimeZone(raw);
  return value && value !== AUTO_ZONE ? value : '';
}

/**
 * The calendar day the CALLING DEVICE is on, from the zone it reported.
 *
 * This is a different question from `resolveTimeZone`'s, and answering both
 * with one rule breaks one of them. That one asks where an ACCOUNT is,
 * generally, so that a reminder nobody is present for still goes out at the
 * right hour — an account-level fact, which is why it prefers the zone the
 * user NAMED and falls back to the last zone any device reported. This one
 * asks what day it is for the client making this request right now, and only
 * that client can answer it:
 *
 *   - The grid draws its last column from the browser's own clock
 *     (`ui/api.js` reads `Intl.DateTimeFormat().resolvedOptions().timeZone`),
 *     never from a setting. So judging its tap against a NAMED zone re-breaks
 *     the write for exactly the person who set one — somebody who keeps
 *     reminders on home time and then travels.
 *   - The stored zone is the last one ANY device reported, so a desktop in
 *     Berlin would have its day decided by the phone that checked in from
 *     Tokyo an hour ago.
 *
 * A caller that reports nothing is one we cannot place, and the server's own
 * clock is the honest answer for it — which is also what it got before this
 * existed, so no caller's day moves by adding it.
 *
 * @param {unknown} reported the `DEVICE_ZONE_HEADER` value, if any
 * @param {Date|number} [instant]
 * @returns {string} 'YYYY-MM-DD'
 */
export function callerDay(reported, instant = Date.now()) {
  return zonedClock(instant, reportedZone(reported)).date;
}

/**
 * Which clock a server-sent reminder is on, for one account.
 *
 * Three tiers, two of which the user sees:
 *
 *   an explicit zone   the account named one — always wins, and is how somebody
 *                      abroad keeps their reminders on home time
 *   `auto`             the zone a client last reported, else the server's
 *   `''`               the server's own clock, chosen deliberately
 *
 * `reported` is never read unless the setting says `auto`, so an account that
 * has named a zone is unaffected by what its devices say — which is the whole
 * point of tier 1 being reachable.
 *
 * Tier 2 is a zone that MOVES, and the one place that is visible is the
 * reminder watermark, which is keyed on the local date this answer decides.
 * Carrying one account across a date line therefore costs a duplicate reminder
 * one way (warned about, as `too_late`) and a silently suppressed one the other
 * (`already_sent`, at debug) — see `dueReminders`, which sets out both and why
 * it is the trade `auto` is rather than a defect in the keying.
 *
 * @param {Record<string, any>} [settings]
 * @param {string} [reported] the zone a client last sent, if any
 * @returns {string} an IANA name, or '' for the server's own clock
 */
export function resolveTimeZone(settings = {}, reported = '') {
  const chosen = settings.notifyTimezone ?? AUTO_ZONE;
  if (chosen !== AUTO_ZONE) return String(chosen);
  // `reportedZone`, not `parseTimeZone`: the latter now accepts `auto` as a
  // legal SETTING, and a client echoing that back would be an account asking
  // itself what time it is. Re-validated here rather than trusted at all,
  // because it arrives on a header and `formatterFor` runs once per account
  // inside the tick.
  return reportedZone(reported);
}

/**
 * Normalise an IANA time zone name, `''` meaning "use the server's own zone".
 *
 * Validated by asking Intl rather than against a list: the list ships with
 * the runtime's ICU data, so anything Intl accepts is exactly what
 * `zonedClock` can later format. A name this rejects would otherwise throw
 * inside the notifier tick, on a schedule, for one user only.
 *
 * What it returns is the CANONICAL name, not the string it was handed, and
 * that is a bound rather than a tidiness. `Intl` matches a zone
 * case-insensitively and resolves aliases, so `america/new_york`,
 * `AMERICA/NEW_YORK`, `AmErIcA/nEw_YoRk` and `US/Eastern` are four spellings
 * it accepts and `formatterFor` would cache under four keys — and that cache
 * is keyed on whatever arrives, holds a built formatter, and is never evicted.
 * That was harmless while the only caller was the notifier tick reading a
 * STORED setting; `callerDay` put a request header on the same path, so a
 * client could mint distinct valid spellings for as long as it cared to.
 * Measured: 16,384 case variants of one name retain 2.2MB after GC, and
 * nothing ever takes them back. Canonicalising collapses them to one key and
 * caps the cache at the ICU zone table, whoever is calling.
 *
 * Offset zones (`+05:30`, and up to `+23:59`) are refused for the same reason
 * twice over. They are the other unbounded family — ~2,900 of them, none a
 * name — and a fixed offset does not observe DST, so an account that somehow
 * stored one would get its reminders an hour out for half the year. Nothing
 * sends them: both clients report `resolvedOptions().timeZone`, which is
 * always a name, and Java's fallback spelling (`GMT+05:30`) `Intl` rejects
 * outright. `Etc/GMT+12` is a real IANA name and is unaffected — it survives
 * canonicalisation as itself, which is what the leading-sign test is testing
 * FOR rather than a slash: `UTC`, `GMT` and `Etc/UTC` all canonicalise to
 * `UTC`, and a slash test would have thrown those away.
 *
 * @param {unknown} raw
 * @returns {string|undefined}
 */
export function parseTimeZone(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === AUTO_ZONE) return AUTO_ZONE;
  if (value.length > 64) return undefined;
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone;
    if (/^[+-]/.test(canonical)) return undefined;
    return canonical;
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

/**
 * Cached formatters: building one per user per tick is not free.
 *
 * Never evicted, which is only safe because every key that reaches here has
 * been through `parseTimeZone` and is therefore CANONICAL — so the key space
 * is the ICU zone table rather than the set of strings a caller can spell.
 * `callerDay` is what made that load bearing: before it, the only zones in
 * here came from stored settings.
 */
const formatters = new Map();

function formatterFor(timeZone) {
  const key = timeZone || '';
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = build(timeZone);
    resolvedZones.set(key, fmt ? key : '');
    if (!fmt) {
      // Said once per zone string, not per account per tick. Falling back is
      // right — one bad value must not end the tick for everyone — but doing it
      // in silence means an account gets every reminder on the server's clock
      // forever with nothing on any surface to say so.
      unusableZones.add(key);
      fmt = build('');
    }
    formatters.set(key, fmt);
  }
  return fmt;
}

/**
 * What each requested zone actually resolved to — itself, or '' if `Intl`
 * refused it and the server's clock stood in.
 *
 * Recorded where the decision is made rather than recomputed: comparing two
 * formatters cannot answer it, because the fallback is a separate object each
 * time. Bounded exactly as `formatters` is.
 *
 * @type {Map<string, string>}
 */
const resolvedZones = new Map();

/**
 * Zones `Intl` refused, so the caller can report the fallback.
 *
 * Held here rather than logged here because this module takes no logger — it is
 * pure by design, which is what lets `dueReminders` be tested with no clock and
 * no transport. `notify-send.js` drains it through the same `once` dedupe that
 * `too_late` and `unreachable` use.
 */
const unusableZones = new Set();

/** @returns {string[]} zones that fell back to the server's clock */
export function takeUnusableZones() {
  const out = [...unusableZones];
  unusableZones.clear();
  return out;
}

/**
 * The zone a clock actually used, which is not always the one asked for.
 *
 * `dueReminders` reports the REQUESTED zone in its skip details, so a
 * `notify.too_late` line for an account whose zone `Intl` will not take printed
 * `zone: 'Mars/Olympus'` while the verdict came from the server's clock —
 * a diagnostic that actively misdirects, which is worse than none.
 *
 * @param {string} timeZone
 */
export function effectiveZone(timeZone) {
  const key = timeZone || '';
  // Read from the resolution `formatterFor` already recorded, rather than
  // building a formatter to find out. This runs once per SKIPPED habit inside
  // the tick, and `done_today` / `already_sent` hold for every habit for the
  // rest of the day once a reminder has gone out — so at the documented
  // ceiling of 500 accounts x 10 habits it ran 5,000 times a minute. Measured:
  // 178ms per tick building each time, 17ms through the cache. 161ms of
  // event-loop block a minute, on the process that also serves requests, to
  // populate one log field.
  if (!resolvedZones.has(key)) formatterFor(key);
  return resolvedZones.get(key) ?? key;
}

/**
 * A formatter for one zone, or null if `Intl` will not have it.
 *
 * Separate so `formatterFor` can fall back. `new Intl.DateTimeFormat` throws a
 * RangeError for an unknown zone, and this is called once per account inside
 * the tick — so one account with an unusable value would end the whole tick for
 * everyone. `parseTimeZone` validates on the way in, but a value can arrive by
 * other roads: a direct JSONB edit, a restored backup, `auto` reaching here
 * unresolved, or ICU data changing under a runtime downgrade. Falling back to
 * the server's clock is wrong for that one account and right for the other 499.
 */
function build(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
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
  } catch {
    return null;
  }
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
 * **The watermark is keyed on the account's LOCAL date, and under `auto` that
 * date can move.** Written down because it reads as a bug the day it happens,
 * and it is not one.
 *
 * `notify_log` holds (habit, channel, local date), and the local date comes
 * from `zonedClock` under whatever `resolveTimeZone` answered on this tick —
 * which for an account set to `auto` is the zone its LAST CLIENT reported. So
 * an account genuinely used from two zones either side of a date boundary can
 * have that boundary crossed by a device checking in rather than by time
 * passing, and the two directions fail differently.
 *
 * **Forward** — a check-in from the later zone, Los Angeles to Tokyo — moves the
 * local date on. The log's row sits under the earlier date, so nothing is found
 * and the gate opens. Inside the catch-up window that is a second send: the same
 * habit twice in one UTC day, one per zone. Past it, this reports `too_late`,
 * which is a WARN — so the noisy half of this is here, and it is the one
 * direction that produces a line an operator will see.
 *
 * **Backward** — Tokyo to Los Angeles — moves the local date back onto a day the
 * log already has a row for, and the answer is `already_sent` on every tick. Not
 * `too_late`: the two gates are eight lines apart and `already_sent` is asked
 * FIRST, deliberately (see the comment on the gate order below), so a present
 * row wins however late the minute is. The arrival day's reminder is therefore
 * suppressed — it was spent on the old clock, at what is the wrong hour on the
 * new one — and `already_sent` logs at DEBUG, so nothing above it says a word.
 * That is the shape somebody would be trying to diagnose: not a warning to look
 * for, but the absence of one.
 *
 * That is the trade `auto` IS, not a defect in the keying, which is why the
 * keying is left alone. The alternative — a UTC date — files every reminder
 * under the wrong day for anyone east or west of the meridian, and gets a user
 * in Auckland reminded again a few hours later, every day, which is the failure
 * the local date was chosen to fix in the first place. Nor can a second key
 * (say, the zone) help: it makes the duplicate certain rather than possible,
 * because two zones would then never share a slot. The exposure is bounded by
 * how often somebody actually carries one account across a date line, and the
 * account that names its zone explicitly — tier one of `resolveTimeZone` — does
 * not have it at all.
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
    // The zone the clock USED, not the one asked for — `effectiveZone` answers
    // '' for a zone Intl refused, and reporting the requested one made a
    // `too_late` line name a zone that had nothing to do with the verdict.
    onSkip(habit, reason, {
      now: clock.time, date: clock.date,
      zone: effectiveZone(timeZone) || 'system', ...detail,
    });
    return undefined;
  };

  for (const habit of habits) {
    if (habit.archived) { skip(habit, 'archived'); continue; }

    const at = minutesOfDay(habit.reminder_time);
    if (at === null) { skip(habit, 'no_reminder_time'); continue; }   // '' — none set

    const late = clock.minutes - at;
    if (late < 0) { skip(habit, 'not_yet', { at: habit.reminder_time, in_minutes: -late }); continue; }

    // Answered and sent are asked BEFORE lateness, and the order is the whole
    // meaning of `too_late`: a reminder that went out at 08:00 is still past its
    // window at 08:31, so testing lateness first reported a delivered reminder as
    // a lost one on every tick for the rest of the day. Nothing was lost — the
    // day was handled — and `too_late` is a warning precisely because it is not.
    if (doneToday.has(habit.id)) { skip(habit, 'done_today'); continue; }
    if (alreadySent(habit.id, clock.date)) { skip(habit, 'already_sent'); continue; }

    if (late > catchUpMinutes) {
      skip(habit, 'too_late', { at: habit.reminder_time, late_minutes: late, catch_up: catchUpMinutes });
      continue;
    }

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

  // The icon prefixes wherever the NAME appears, and nowhere else: a custom
  // prompt is a question, not a name, so its title is untouched by it.
  const icon = String(habit.icon ?? '');
  const shown = icon ? `${icon} ${name}` : name;

  const generated = goal
    ? `Time to log this one — goal: ${goal}.`
    : 'Time to check in — have you done this today?';

  if (test) {
    return {
      title: custom || shown,
      subtitle: shown,
      body: 'Test notification from habiterall. Buttons here record nothing.',
    };
  }

  // With a prompt, it leads and the generated sentence is dropped — repeating
  // "have you done this today?" under "Did you exercise today?" is noise.
  // Without one, the name leads exactly as before.
  return custom
    ? { title: custom, subtitle: shown, body: goal ? `Goal: ${goal}.` : '' }
    : { title: shown, subtitle: '', body: generated };
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
 * A yes/no habit gets Yes / No. A measurable one gets "Enter amount", which
 * opens a modal — there is no button that can mean "6". Skip joins either when
 * the account has skip days switched on, because "not applicable today" is a
 * distinct answer from both — and is absent when it does not, or the setting
 * would hide the step from the two clients that own a grid while offering it
 * from the shade of a third.
 *
 * A press on a skip button in an OLD message is still honoured: the message is
 * already sitting in a channel, the id in it says what it says, and refusing it
 * would mean a button that visibly does nothing. Switching the setting off stops
 * new ones being offered, which is what it promises.
 *
 * Returns `[]` when there is nothing to attach, so a webhook send (which
 * cannot carry components at all) simply gets an empty list.
 *
 * @param {import('./types.js').Habit} habit
 * @param {{date?: string, test?: boolean, skipDays?: boolean}} [opts]
 */
export function reminderComponents(habit, { date = '', test = false, skipDays = false } = {}) {
  const id = (action) => encodeAction({ habitId: habit.id, date, action, test });

  const buttons = habit.type === 'numerical'
    ? [{ type: 2, style: STYLE.primary, label: 'Enter amount', custom_id: id('amount') }]
    : [
      { type: 2, style: STYLE.success, label: 'Yes', custom_id: id('yes') },
      { type: 2, style: STYLE.secondary, label: 'No', custom_id: id('no') },
    ];

  if (skipDays) {
    buttons.push({ type: 2, style: STYLE.secondary, label: 'Skip', custom_id: id('skip') });
  }

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
  // Trailing slashes are counted off rather than matched: `/\/+$/` is unanchored
  // at the start, so on a string of many slashes the engine retries from every
  // one of them — quadratic work for a one-line normalisation.
  if (/^https?:\/\//.test(appUrl)) {
    let end = appUrl.length;
    while (end > 0 && appUrl[end - 1] === '/') end--;
    embed.url = `${appUrl.slice(0, end)}/`;
  }

  return {
    username: 'habiterall',
    embeds: [embed],
    // A habit may be called anything, including '@everyone'. Embeds do not
    // resolve mentions today, but this is the guarantee rather than a
    // side-effect of where the text happens to sit.
    allowed_mentions: { parse: [] },
  };
}
