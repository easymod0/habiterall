/**
 * Talking to Discord as an application, and answering a button press.
 *
 * Two things live here that the webhook path in notify-send.js does not need:
 *
 *   1. Posting as a BOT. `components` — buttons — are only accepted on a
 *      message from an application, so a plain channel webhook can never carry
 *      them however it is phrased. That is the whole reason bot mode exists.
 *   2. Handling the click. An interaction has to be answered within three
 *      seconds, and the answer is a specific shape per kind: replace the
 *      message, or open a modal.
 *
 * Interactions arrive over the gateway (discord-gateway.js), not over HTTP, so
 * a self-hosted instance behind NAT needs no inbound port and no public URL.
 * That also means there is no request signature to verify: the socket is
 * authenticated by the bot token, and nothing else can put frames on it.
 *
 * Every network call takes an injected `fetch`, so all of this is testable
 * without touching Discord.
 */

import {
  answerText, discordPayload, parseAction, reminderComponents, reminderMessage,
} from './notify.js';

const API = 'https://discord.com/api/v10';

/** Interaction types, from Discord's docs, by name. */
export const INTERACTION = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL: 5 };

/** Interaction callback types, likewise. */
export const CALLBACK = {
  MESSAGE: 4,
  DEFER: 5,
  /**
   * "Received, nothing to show yet" — the acknowledgement that leaves the
   * message exactly as it is. `DEFER` (5) posts a visible "thinking" placeholder
   * for a REPLY; this one is its counterpart for an EDIT, and it is what a
   * reminder wants: the answer arrives as a change to the reminder itself, so
   * anything shown in the meantime would be a second message to clean up.
   */
  DEFER_UPDATE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
};

/** Discord's "only the clicker sees this" message flag. */
const EPHEMERAL = 64;

/** A hung request must not hold up a tick or an interaction. */
const TIMEOUT_MS = 10_000;

/**
 * How stale a button may be and still record something.
 *
 * A reminder's buttons keep working after the moment they were sent — that is
 * the point, since the notification sits in the channel until it is answered.
 * But not forever: the `custom_id` carries a date, and accepting an arbitrary
 * one would let a week-old message quietly rewrite history. Two days covers
 * "answered it the next morning" and stops there.
 */
export const MAX_ANSWER_AGE_DAYS = 2;

/**
 * A minimal REST call. Returns the same three-way answer as `postWebhook`:
 * fine, retryable, or permanently broken.
 *
 * @param {{token?: string, method?: string, path: string, body?: unknown}} req
 * @param {{fetch?: typeof globalThis.fetch, timeoutMs?: number}} [deps]
 */
export async function discordRequest(req, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS);

  try {
    const headers = { 'Content-Type': 'application/json' };
    // A bot token is an instance credential; it never appears in user settings
    // and never leaves this header.
    if (req.token) headers.Authorization = `Bot ${req.token}`;

    const res = await doFetch(`${API}${req.path}`, {
      method: req.method ?? 'POST',
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
      redirect: 'manual',
    });

    if (res.status === 429) {
      const seconds = Number(res.headers?.get?.('retry-after'));
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 1;
      return { ok: false, status: 429, error: 'rate limited by Discord', retryAfterMs: wait * 1000 };
    }

    // 401 is the token, 403 is the bot's permissions in that channel, 404 is a
    // channel that does not exist or that the bot cannot see. None of the three
    // fixes itself, and retrying every minute helps nobody.
    if ([401, 403, 404].includes(res.status)) {
      return {
        ok: false,
        status: res.status,
        permanent: true,
        error: res.status === 401
          ? 'the bot token was rejected — check DISCORD_BOT_TOKEN'
          : 'the bot cannot post in that channel — check the id, and that the bot was invited',
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, error: `Discord returned ${res.status}` };
    }

    return { ok: true, status: res.status };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: aborted ? `no response within ${deps.timeoutMs ?? TIMEOUT_MS}ms`
        : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post a reminder into a channel as the bot, with its buttons.
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.channelId
 * @param {import('./types.js').Habit} args.habit
 * @param {string} [args.date]
 * @param {string} [args.appUrl]
 * @param {boolean} [args.test]
 * @param {boolean} [args.skipDays] whether the account offers skip days
 * @param {{fetch?: typeof globalThis.fetch}} [deps]
 */
export function postReminder(args, deps = {}) {
  const {
    token, channelId, habit, date = '', appUrl = '', test = false, skipDays = false,
  } = args;
  const message = reminderMessage(habit, { test });
  const payload = discordPayload({ habit, message, date, appUrl });

  // `username` is a webhook-only field; a bot message carrying it is rejected.
  delete payload.username;
  payload.components = reminderComponents(habit, { date, test, skipDays });

  return discordRequest(
    { token, path: `/channels/${channelId}/messages`, body: payload },
    deps
  );
}

/**
 * Answer an interaction, before or after it has been acknowledged.
 *
 * The FIRST answer has three seconds to leave, and goes to the callback
 * endpoint. That endpoint is then spent: everything after it goes to the
 * webhook on the same interaction token, which stays valid for fifteen minutes.
 * `deps.acknowledged` says which of the two this is.
 *
 * Two shapes reach the second case, and the response the caller already built
 * says which — so `handleInteraction` reads the same either way:
 *
 *   UPDATE_MESSAGE  -> PATCH the message the button was on. This is the
 *                      reminder becoming its own answer, which is the point of
 *                      editing rather than replying.
 *   MESSAGE         -> POST a new message. Ours are all ephemeral, so this is
 *                      a private note to whoever clicked and nothing else.
 *
 * The interaction token is single-use and short-lived, so none of this needs a
 * bot token — which is also why it is safe for the gateway loop to hand the
 * token straight through. `application_id` rides on the interaction, so the
 * webhook path needs no extra call to find out who we are either.
 *
 * @param {any} interaction
 * @param {any} response
 * @param {{fetch?: typeof globalThis.fetch, timeoutMs?: number,
 *          acknowledged?: boolean}} [deps]
 */
export function respondInteraction(interaction, response, deps = {}) {
  if (!deps.acknowledged) {
    return discordRequest(
      {
        path: `/interactions/${interaction.id}/${interaction.token}/callback`,
        body: response,
      },
      deps
    );
  }

  const webhook = `/webhooks/${interaction.application_id}/${interaction.token}`;
  return response?.type === CALLBACK.UPDATE_MESSAGE
    ? discordRequest(
      { method: 'PATCH', path: `${webhook}/messages/@original`, body: response.data },
      deps
    )
    : discordRequest({ method: 'POST', path: webhook, body: response.data }, deps);
}

/* ---------- the shapes of an answer ---------- */

/** A note only the person who clicked can see. */
export function ephemeral(text) {
  return { type: CALLBACK.MESSAGE, data: { content: text, flags: EPHEMERAL } };
}

/**
 * Replace the reminder with the same message, minus its buttons, plus what was
 * recorded.
 *
 * Editing rather than replying is deliberate: the channel ends up with one
 * message per reminder that reads "Did you exercise today? — Recorded: Done",
 * instead of a reminder followed by a second message answering it. Removing the
 * buttons is what stops a second click recording twice.
 */
export function answeredUpdate(message, text) {
  const original = message?.embeds?.[0] ?? {};
  const embed = { ...original };

  // Replace rather than append, so pressing twice (possible if the edit fails
  // and the buttons survive) cannot grow the field list without bound.
  embed.fields = [
    ...(embed.fields ?? []).filter((f) => f?.name !== 'Recorded'),
    { name: 'Recorded', value: String(text).slice(0, 1024) },
  ].slice(0, 25);

  return { type: CALLBACK.UPDATE_MESSAGE, data: { embeds: [embed], components: [] } };
}

/**
 * The box for typing an amount.
 *
 * The label is the habit's own prompt where it has one, so "How many cups of
 * water did you drink today?" is asked in the place the answer is given.
 */
export function amountModal(habit, { date, prompt }) {
  const unit = String(habit.unit ?? '').trim();
  return {
    type: CALLBACK.MODAL,
    data: {
      custom_id: `hab|${habit.id}|${date}|amount`,
      // Discord caps a modal title at 45 characters, which is shorter than a
      // prompt is allowed to be — so the prompt goes on the input's label,
      // which allows 45 too but the habit name is the safer title.
      title: String(habit.name ?? 'Record').slice(0, 45),
      components: [{
        type: 1,
        components: [{
          type: 4,                      // text input
          custom_id: 'amount',
          style: 1,                     // single line
          label: (prompt || `How many${unit ? ` ${unit}` : ''}?`).slice(0, 45),
          placeholder: unit || 'a number',
          required: true,
          max_length: 12,
        }],
      }],
    },
  };
}

/* ---------- handling a click ---------- */

/** The Discord user who clicked, in a guild or in a DM. */
function clickedBy(interaction) {
  return interaction?.member?.user?.id ?? interaction?.user?.id ?? '';
}

/** The amount typed into the modal, or null. */
function modalValue(interaction) {
  const rows = interaction?.data?.components ?? [];
  for (const row of rows) {
    for (const field of row?.components ?? []) {
      if (field?.custom_id === 'amount') return field.value ?? null;
    }
  }
  return null;
}

/** Days between two 'YYYY-MM-DD' dates, positive when `a` is earlier. */
function daysApart(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Turn a button press or a modal submission into a recorded entry.
 *
 * The adapter is what each edition supplies:
 *
 *   resolveChannel(channelId) -> account | null
 *       The account whose reminders go to this channel. This — not the
 *       `custom_id` — is what decides whose data is written, so a forged id
 *       cannot reach another account: `record` then looks the habit up within
 *       the account it was given.
 *   record(account, {habitId, date, action, value}) -> {ok, habit?, text?, error?}
 *       Applies the same validation and the same storage rule as the API,
 *       through shared/validate.js.
 *   findHabit(account, habitId) -> habit | null
 *       Needed to label the amount modal; scoped to the account, like `record`.
 *   today(account) -> 'YYYY-MM-DD' in the account's own zone.
 *
 * Returns the response that was sent, for tests and logging.
 *
 * @param {any} interaction
 * @param {{resolveChannel: Function, record: Function, findHabit: Function,
 *          today: Function, respond?: Function,
 *          log?: {warn?: Function, error?: Function}}} adapter
 */
export async function handleInteraction(interaction, adapter) {
  const respond = adapter.respond ?? ((i, r, opts) => respondInteraction(i, r, opts));
  const log = adapter.log ?? console;

  // Whether the three-second callback has been spent, which is all `respond`
  // needs to know to pick an endpoint.
  let acknowledged = false;
  const send = async (response) => {
    await respond(interaction, response, { acknowledged });
    return response;
  };

  const type = interaction?.type;
  if (type !== INTERACTION.COMPONENT && type !== INTERACTION.MODAL) return null;

  const parsed = parseAction(interaction?.data?.custom_id);
  // Not one of ours — another bot's component id, or a stale format. Silence is
  // right: answering would put a message in someone else's conversation.
  if (!parsed) return null;

  if (parsed.test) {
    return send(answeredUpdate(
      interaction.message,
      'Nothing — this was a test message.'
    ));
  }

  // Acknowledge BEFORE touching storage, because everything below this line is
  // storage. Discord allows three seconds and the work is up to three round
  // trips through the database — resolve the channel, ask what day it is there,
  // record — so on a cold pool or a container that has just started, the press
  // was written and Discord had already told the user "This interaction
  // failed". The worst kind of failure message: it says the opposite of what
  // happened, and the natural response is to press again. Deferred, the token
  // is good for fifteen minutes and the storage work has all the time it needs.
  //
  // A modal is the exception, and cannot be helped: it must be OPENED within
  // the three seconds, so there is nothing to defer to. It does one lookup and
  // no write, which is why it is the path that can afford to stay as it was.
  //
  // Ordering worth knowing rather than rediscovering: it is removing the
  // buttons that stops a second click recording twice, and a defer delays that
  // — so the buttons stay live while the write is in flight. `record` is an
  // upsert for every action, so a double press is idempotent and the window
  // costs nothing.
  const opensModal = type === INTERACTION.COMPONENT && parsed.action === 'amount';
  if (!opensModal && interaction.message) {
    // Not conditional on the result: a defer that fails leaves the interaction
    // lost either way, and the write is the half worth finishing.
    await respond(interaction, { type: CALLBACK.DEFER_UPDATE }, { acknowledged });
    acknowledged = true;
  }

  const account = await adapter.resolveChannel(interaction.channel_id);
  if (!account) {
    return send(ephemeral(
      'This channel is not linked to a habiterall account any more.'
    ));
  }

  // When the account has named its Discord user, only that user's clicks count.
  // Without it, anyone who can see the channel can answer — which is fine for a
  // private channel and is why the setting exists for every other case.
  const owner = String(account.settings?.discordUserId ?? '');
  if (owner && clickedBy(interaction) !== owner) {
    return send(ephemeral('These are not your habits.'));
  }

  const today = await adapter.today(account);
  const age = daysApart(parsed.date, today);
  if (age < 0) {
    return send(ephemeral('That reminder is for a future date, which cannot be recorded.'));
  }
  if (age > MAX_ANSWER_AGE_DAYS) {
    return send(ephemeral(
      `That reminder is ${age} days old — open the app to record it.`
    ));
  }

  // A number cannot come from a button, so the button opens a box first. This
  // is the `opensModal` path above, undeferred and answered inside the three
  // seconds — a callback of type MODAL is the only way to open one at all.
  if (opensModal) {
    const habit = await adapter.findHabit?.(account, parsed.habitId);
    if (!habit) return send(ephemeral('That habit no longer exists.'));
    return send(amountModal(habit, {
      date: parsed.date,
      prompt: String(habit.reminder_message ?? '').trim(),
    }));
  }

  let value;
  if (type === INTERACTION.MODAL) {
    const raw = modalValue(interaction);
    const text = String(raw ?? '').trim().replace(',', '.');
    // The emptiness check comes first, and on purpose: `Number('')` is 0, which
    // is finite and non-negative, so an empty box would record a zero — and for
    // an "at most" habit a zero is a *success*. The input is marked required,
    // but that is Discord's promise to keep, not ours to assume.
    value = text === '' ? NaN : Number(text);
    if (!Number.isFinite(value) || value < 0) {
      return send(ephemeral(`"${raw}" is not a number I can record.`));
    }
  }

  try {
    const result = await adapter.record(account, {
      habitId: parsed.habitId,
      date: parsed.date,
      action: parsed.action,
      value,
    });

    if (!result?.ok) {
      return send(ephemeral(result?.error ?? 'That could not be recorded.'));
    }

    const text = result.text ?? answerText(result.habit ?? {}, {
      action: parsed.action, value,
    });
    // The modal has no message to edit when it was opened from a slash command,
    // but ours always comes from a button, so the reminder is there to update.
    return send(interaction.message
      ? answeredUpdate(interaction.message, text)
      : ephemeral(`Recorded: ${text}`));
  } catch (err) {
    log.error?.('discord: recording an interaction failed:', err);
    return send(ephemeral('Something went wrong recording that.'));
  }
}
