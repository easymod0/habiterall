/**
 * Answering a reminder from ntfy's own action buttons.
 *
 * ntfy's `interactive: false` used to be the whole answer: an ntfy action is an
 * HTTP request the SUBSCRIBING DEVICE makes, from wherever it happens to be, so
 * making the buttons work meant an inbound endpoint authorised by nothing but
 * the shape of the request — the topic gates who can *see* a reminder, not who
 * may *answer* it, and a topic URL is a thing somebody typed, not a channel to
 * resolve an account from the way `discord.js` resolves one from a bot channel.
 *
 * This file is that answer reversed: the button still comes to US, at
 * `NTFY_ANSWER_PATH`, and what authorises the request is an HMAC code over
 * exactly what it is allowed to change — one account, one habit, one date, one
 * action, one value. It is NOT replay-inert — `record` is an upsert, so a kept
 * code can overwrite a later correction on the same date, repeatably, for up
 * to `MAX_ANSWER_AGE_DAYS` — and the capability is bounded to answering a
 * question the user was already being asked, for a habit and a date already
 * visible in the same message. See `docs/decisions/ntfy-answers.md`'s
 * worst-case paragraph for the bound in full. Nothing here is a bearer token
 * for the account: it cannot list habits, cannot read anything, and cannot
 * name a date outside `MAX_ANSWER_AGE_DAYS`.
 *
 * Pure logic — no express, no storage, no fetch — exactly like `discord.js`,
 * which `handleNtfyAnswer` is modelled on directly: read that file's
 * `handleInteraction` first. What is simpler here is that there is no
 * three-second callback to defer past; what carries over unchanged is the
 * adapter contract and "everything below account resolution is storage, and
 * all of it can throw".
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { daysBetween } from './stats.js';
import { MAX_ANSWER_AGE_DAYS } from './discord.js';
import { ACTIONS, usableAppUrl } from './notify.js';
import { DATE_RE } from './validate.js';
// The one import reaching into `shared/public` that this file needs, mirroring
// `notify.js:36` and for the same reason: node can read anything on disk, the
// browser cannot see `shared/src`, and `toggle.js` is already DOM-free and
// already imported by a node test. See the comment there for the argument in
// full; it is not repeated per file on purpose.
import { isAvoided } from '../public/ui/toggle.js';

/**
 * Where the button posts, and where both editions mount the route.
 *
 * One declaration, imported by the URL builder below and by each edition's
 * route mount, so the button and the route cannot name two different paths.
 */
export const NTFY_ANSWER_PATH = '/notify/ntfy/answer';

/* ---------- the code ---------- */

/** Format version. A future change to the shape is a rejection, not a misparse. */
const VERSION = 'v1';

/** Truncated MAC length. 16 bytes is 22 base64url characters, asserted by a test. */
const MAC_BYTES = 16;

/**
 * The label an ntfy code's HMAC key is derived under.
 *
 * Never the raw instance secret — that secret also signs the session cookie,
 * and an HMAC key doubling as both would let a code (which an unauthenticated
 * request can try to break) double as an oracle against session signing.
 * `createHmac` is used as a plain PRF here, keyed by the real secret, to turn
 * it into a key that is good for nothing but this.
 */
const KEY_LABEL = 'habiterall/ntfy-answer/v1';

/** @returns {Buffer} the derived signing key, never the raw secret */
function deriveKey(secret) {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

/**
 * @param {object} args
 * @param {string} args.secret the instance secret
 * @param {string} args.account '' on personal, the numeric user id on cloud
 * @param {number} args.habitId
 * @param {string} args.date 'YYYY-MM-DD'
 * @param {string} args.action one of `ACTIONS` in notify.js
 * @param {number} [args.value]
 * @param {boolean} [args.test]
 * @returns {string} `v1.<b64url payload>.<b64url mac>`
 */
export function signNtfyAnswer({
  secret, account, habitId, date, action, value, test = false,
}) {
  // Field order is fixed by construction (an object literal serialises in the
  // order its keys were written), but that is a nicety and not the safety
  // property: the MAC is over these exact bytes, whatever they are, and
  // `verifyNtfyAnswer` never re-serialises to compare — it reads the same
  // bytes back out of the token.
  const payload = {
    account, habitId, date, action, value: value ?? null, test: Boolean(test),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const mac = createHmac('sha256', deriveKey(secret)).update(payloadBytes).digest()
    .subarray(0, MAC_BYTES);

  return `${VERSION}.${payloadBytes.toString('base64url')}.${mac.toString('base64url')}`;
}

/** The three dot-separated segments, or `null` for anything not shaped like one. */
const TOKEN_RE = /^([^.]*)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/**
 * Verify a code and return what it grants, or `null`.
 *
 * Never throws — every malformed shape, wrong version, wrong length, wrong
 * MAC and (below) wrong SHAPE answers `null` the same way, because the caller
 * is an unauthenticated route and the difference between "forged" and
 * "corrupt" is not this function's to report.
 *
 * The MAC is checked BEFORE the payload is parsed: only once the bytes are
 * known to be ours does `JSON.parse` run on them at all.
 *
 * Once the bytes ARE known to be ours, the fields inside them still get the
 * same shape check Discord's `parseAction` gives a `custom_id` on the way back
 * in — `ACTIONS` membership, `DATE_RE`, an integer habit id — because the MAC
 * establishes PROVENANCE, not shape, and ntfy being laxer than Discord here has
 * no reason behind it. `test` is exempt from the habit-id and date checks,
 * exactly as `parseAction`'s `TEST_PREFIX` branch is: a test code never reaches
 * `record`, so there is no habit or date to have an opinion about.
 *
 * @param {unknown} token
 * @param {{secret: string}} args
 * @returns {{account: string, habitId: number, date: string, action: string,
 *   value: number|null, test: boolean}|null}
 */
export function verifyNtfyAnswer(token, { secret }) {
  const match = TOKEN_RE.exec(String(token ?? ''));
  if (!match) return null;
  const [, version, payloadB64, macB64] = match;
  if (version !== VERSION) return null;

  const payloadBytes = Buffer.from(payloadB64, 'base64url');
  const macBytes = Buffer.from(macB64, 'base64url');

  const expectedMac = createHmac('sha256', deriveKey(secret)).update(payloadBytes).digest()
    .subarray(0, MAC_BYTES);

  // Guarded before the comparison: `timingSafeEqual` THROWS for buffers of
  // unequal length rather than answering false, and a truncated or padded
  // token is exactly a length that can differ from `MAC_BYTES`.
  if (macBytes.length !== expectedMac.length) return null;
  if (!timingSafeEqual(macBytes, expectedMac)) return null;

  try {
    const parsed = JSON.parse(payloadBytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;

    const test = Boolean(parsed.test);
    if (!ACTIONS.includes(parsed.action)) return null;
    if (!test) {
      if (!Number.isSafeInteger(parsed.habitId) || parsed.habitId <= 0) return null;
      if (!DATE_RE.test(String(parsed.date ?? ''))) return null;
    }
    const value = parsed.value ?? null;
    if (value !== null
        && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      return null;
    }

    return {
      account: parsed.account,
      habitId: parsed.habitId,
      date: parsed.date,
      action: parsed.action,
      value,
      test,
    };
  } catch {
    return null;
  }
}

/* ---------- handling a press ---------- */

/**
 * Turn a verified ntfy code into a recorded entry.
 *
 * Modelled on `handleInteraction` (`discord.js:348`) — same shape, same
 * ordering, and the same reason for the ordering: everything past account
 * resolution is storage, and storage can throw. What is simpler here: there is
 * no three-second callback to acknowledge before touching it, because ntfy has
 * no equivalent of Discord's deferred response — the request either answers
 * with a status code or it does not, and that status code IS the answer.
 *
 * @param {string} token
 * @param {{secret: () => string,
 *   resolveAccount: (accountRef: unknown) => Promise<any|null>,
 *   today: (account: any) => Promise<string>,
 *   record: (account: any, args: {habitId: number, date: string, action: string,
 *     value?: number|null}) => Promise<{ok: boolean, habit?: any, text?: string, error?: string}>,
 *   log?: {error?: Function}}} adapter
 * @returns {Promise<{status: number, text?: string, error?: string}>}
 */
export async function handleNtfyAnswer(token, adapter) {
  const log = adapter.log ?? console;

  const parsed = verifyNtfyAnswer(token, { secret: adapter.secret() });
  if (!parsed) return { status: 403 };

  // Mirrors `TEST_PREFIX`: the *Send a test notification* button exercises the
  // whole path — sign, deliver, press, verify — without recording anything, so
  // storage is never reached for it.
  if (parsed.test) {
    return { status: 200, text: 'Nothing — this was a test message.' };
  }

  // Everything from here is storage, and all of it can throw — a pool that has
  // gone away takes `resolveAccount` and `today` down as readily as `record`.
  try {
    const account = await adapter.resolveAccount(parsed.account);
    // Deliberately the SAME shape as a verify failure above: a forged code and
    // a reference to an account that does not exist must be indistinguishable,
    // or this route becomes an oracle for which accounts exist.
    if (!account) return { status: 403 };

    const today = await adapter.today(account);
    const age = daysBetween(parsed.date, today);
    if (age < 0) return { status: 400, error: 'that date is in the future' };
    if (age > MAX_ANSWER_AGE_DAYS) {
      return { status: 410, error: `that reminder is ${age} days old` };
    }

    const result = await adapter.record(account, {
      habitId: parsed.habitId, date: parsed.date, action: parsed.action, value: parsed.value,
    });

    return result?.ok
      ? { status: 200, text: result.text }
      : { status: 400, error: result?.error ?? 'that could not be recorded' };
  } catch (err) {
    log.error?.('ntfy: recording an answer failed:', err);
    return { status: 500 };
  }
}

/* ---------- the buttons ---------- */

/** ntfy takes at most three actions on a message. */
const MAX_NTFY_ACTIONS = 3;

/**
 * Above this integer target, or for any non-integer one, a midpoint button is
 * not offered. **A test asserts the literal 10, not this constant** — a test
 * importing the name it checks pins the name and nothing else, and this repo
 * has shipped that exact defect.
 */
const AT_LEAST_MIDPOINT_MAX = 10;

/** A label is short by nature, but `habit.unit` is free text a user typed. */
const MAX_ACTION_LABEL = 40;

/** First occurrence of each value, in order — never a repeated recorded value. */
function dedupeByValue(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * The counts a numerical (non-avoided) habit offers, before Skip.
 *
 * @param {import('./types.js').Habit} habit
 * @param {boolean} skipDays
 * @returns {number[]}
 */
function numericCounts(habit, skipDays) {
  const target = Number(habit.target_value) || 0;

  if (habit.target_type === 'at_most') {
    // Always 0/1/2, whatever the limit — over the limit is an app trip, not a
    // button. With skipDays the TOP count drops, because an at-most habit
    // counts UP from zero and 0/1 are the two answers most worth a button.
    return skipDays ? [0, 1] : [0, 1, 2];
  }

  // at_least. With skipDays the MIDPOINT drops instead — Skip takes its slot —
  // so the target itself stays one press away either way.
  if (skipDays) return dedupeByValue([0, target]);

  const hasMidpoint = Number.isInteger(target)
    && target >= 0 && target <= AT_LEAST_MIDPOINT_MAX;
  return hasMidpoint
    ? dedupeByValue([0, Math.round(target / 2), target])
    : dedupeByValue([0, target]);
}

/**
 * The ntfy action buttons for one reminder.
 *
 * @param {import('./types.js').Habit} habit
 * @param {object} opts
 * @param {string} [opts.date]
 * @param {boolean} [opts.skipDays]
 * @param {boolean} [opts.test]
 * @param {string} [opts.appUrl] this instance's own public address. No buttons
 *   at all without one — `interactive` is a predicate on exactly this.
 * @param {(fields: {habitId: number, date?: string, action: string,
 *   value?: number, test?: boolean}) => string} opts.sign signs one button's
 *   payload; injected so this module needs no secret of its own (and the
 *   tests need no crypto) — the edition binds it to the instance secret and
 *   the account before this is ever called.
 * @returns {{action: 'http', label: string, url: string, method: 'POST',
 *   headers: {}, body: '', clear: true}[]}
 */
export function ntfyActions(habit, {
  date = '', skipDays = false, test = false, appUrl = '', sign,
}) {
  // The same helper `CHANNELS.ntfy.interactive` uses (`notify.js`), and this
  // builds from what it RETURNS rather than from the raw `appUrl` — a
  // boolean predicate over the parsed url beside string concatenation of the
  // raw one is exactly the drift `usableAppUrl`'s own comment describes: a
  // value like `'https:/h.example'` or `'HTTPS://h.example'` passed the old
  // predicate while the raw-string builder shipped a URL the predicate never
  // actually validated, which — since ntfy only clears a notification on a
  // successful request — is a button that neither records nor ever clears.
  const base = usableAppUrl(appUrl);
  if (!base) return [];

  // A non-test button's code carries `date`, and step 3's post-MAC shape
  // check in `verifyNtfyAnswer` rejects one that fails `DATE_RE` — so a
  // missing or malformed date here would build a button that 403s forever
  // and, because ntfy only clears a notification on a SUCCESSFUL request,
  // never even clears. Rather than ship a button that cannot work, this is
  // the same "no buttons" outcome as no `appUrl`. Unreachable today
  // (`deliverAccount` always passes `item.date`; `sendTest` passes
  // `test: true`, which skips this), but a future caller that forgets a
  // date deserves no buttons, not a silently dead one — exactly the failure
  // shape `notify_status` exists for. A `test: true` call is exempt: its
  // code never reaches storage, so it has no date to be wrong about.
  if (!test && !DATE_RE.test(date)) return [];

  const avoided = isAvoided(habit);
  const unit = String(habit.unit ?? '').trim();

  /** @type {{label: string, action: string, value?: number}[]} */
  let steps;
  if (habit.type === 'numerical' && !avoided) {
    // A number cannot come from a button on ntfy either — no modal to open,
    // so the count itself rides on the existing `amount` action instead. Both
    // editions' `record()` already handle it as their fallthrough; `ACTIONS`
    // gains nothing and the storage path is untouched.
    steps = numericCounts(habit, skipDays).map((value) => ({
      label: `${value}${unit ? ` ${unit}` : ''}`.slice(0, MAX_ACTION_LABEL),
      action: 'amount',
      value,
    }));
  } else {
    // Boolean, or an avoided habit — numerical by definition
    // (`show_as: 'avoid'` requires at_most + numerical), so Clean/Slipped
    // replaces a number pad that would ask the wrong question for something
    // you're trying not to do. The ACTIONS do not invert; only the labels do.
    steps = [
      { label: avoided ? 'Clean' : 'Yes', action: 'yes' },
      { label: avoided ? 'Slipped' : 'No', action: 'no' },
    ];
  }

  if (skipDays) steps.push({ label: 'Skip', action: 'skip' });

  return steps.slice(0, MAX_NTFY_ACTIONS).map(({ label, action, value }) => ({
    action: 'http',
    label,
    url: `${base}${NTFY_ANSWER_PATH}?c=${encodeURIComponent(
      sign({ habitId: habit.id, date, action, value, test })
    )}`,
    method: 'POST',
    headers: {},
    body: '',
    // Honest in this design: ntfy clears the notification only when the
    // request SUCCEEDS, and the request comes to us, so the phone sees our own
    // status code rather than "delivered to whoever we asked".
    clear: true,
  }));
}
