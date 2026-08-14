/**
 * User preferences.
 *
 * A small registry rather than scattered storage calls: adding an option
 * means adding one entry to SETTINGS, and the dialog, defaults, validation
 * and persistence all follow from it.
 *
 * Preferences live on the SERVER, so they follow the account rather than the
 * device — set "today on the left" on a laptop and a phone agrees. The
 * server is authoritative; localStorage is only a cache so the first paint
 * after a reload (or any paint while offline) uses the right values instead
 * of flashing the defaults.
 */

const CACHE_KEY = 'habiterall-settings';

/**
 * @typedef {object} SettingDef
 * @property {string} label      shown in the settings dialog
 * @property {string} [help]     one-line explanation under the control
 * @property {'select'|'toggle'|'multi'|'text'} type
 * @property {any} default
 * @property {{value: string, label: string}[]} [options]  for `select` and `multi`
 * @property {string} [placeholder]  for `text`
 * @property {string} [section]  groups controls in the dialog
 * @property {(values: Record<string, any>) => boolean} [requires]
 *   when present, the control is only shown while this holds — a webhook URL
 *   is noise until its channel is switched on
 * @property {(value: any) => boolean} [validate]
 *   overrides the type's own check, for a value whose legal set is not a list
 */

/**
 * Notification destinations.
 *
 * The ids and their meanings live in shared/src/notify.js, which is what the
 * server enforces and what the notifier delivers with; this is the render
 * side, exactly as SETTINGS is the render side of SETTING_VALUES.
 * test/notify.test.js fails if the two lists drift.
 */
const CHANNEL_OPTIONS = [
  { value: 'android', label: 'Android app (on-device alarm, works offline)' },
  { value: 'discord', label: 'Discord channel (sent by the server)' },
];

/** The zone the browser is in, e.g. 'Europe/Berlin'. */
function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** Whether Intl here understands a zone name — the same test the server makes. */
function knownTimeZone(value) {
  if (typeof value !== 'string') return false;
  if (value === '') return true;                 // '' = use the server's zone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every zone this browser knows, so the reminder time can mean what the user
 * means by it. Long, but a list of ~400 names in a `<select>` is still far
 * better than asking someone to type 'America/Argentina/Buenos_Aires'.
 */
function timeZoneOptions() {
  const device = deviceTimeZone();
  let zones = [];
  try {
    zones = Intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  if (!zones.length && device) zones = [device];

  return [
    { value: '', label: "Server's own timezone" },
    ...zones.map((zone) => ({
      value: zone,
      label: zone === device ? `${zone} (this device)` : zone,
    })),
  ];
}

/**
 * The available settings.
 *
 * Every key here must also appear in SETTING_VALUES in
 * shared/src/validate.js, which is what the server enforces — the client's
 * list is for rendering, not for trust. A test fails if the two drift.
 *
 * @type {Record<string, SettingDef>}
 */
export const SETTINGS = {
  dayOrder: {
    section: 'Dashboard',
    label: 'Day order',
    help: 'Which end of the row holds today.',
    type: 'select',
    // Today first by default: it is the day you act on, so it belongs where
    // the eye lands rather than at the far end of the row.
    default: 'newest-left',
    options: [
      { value: 'newest-left', label: 'Newest first (today on the left)' },
      { value: 'newest-right', label: 'Oldest first (today on the right)' },
    ],
  },
  weekStart: {
    section: 'Dashboard',
    label: 'Week starts on',
    help: 'Used by the history and times-per-week charts.',
    type: 'select',
    default: 'monday',
    options: [
      { value: 'monday', label: 'Monday' },
      { value: 'sunday', label: 'Sunday' },
    ],
  },
  calendarZoom: {
    section: 'Dashboard',
    label: 'Calendar zoom',
    help: 'How much history the completion calendar shows at once.',
    type: 'select',
    default: 'default',
    options: [
      { value: 'closest', label: 'Closest — largest squares' },
      { value: 'close', label: 'Close — bigger squares' },
      { value: 'default', label: 'Default' },
      { value: 'wide', label: 'Wide — smallest squares, most history' },
    ],
  },
  // Loop's two tracking preferences, with Loop's keys' own defaults. Both off:
  // the three-state cycle and a plain empty square are what the app has always
  // done, and each of these adds a state to think about.
  skipDays: {
    section: 'Tracking',
    label: 'Enable skip days',
    help: 'Adds "skip" to the tap cycle, for a day the habit does not apply. ' +
      'A skip leaves your score and streak untouched rather than breaking them.',
    type: 'toggle',
    default: false,
  },
  questionMarks: {
    section: 'Tracking',
    label: 'Show question marks for missing data',
    help: 'Tells a day you marked as missed apart from a day you never answered, ' +
      'which is drawn as “?”. With it on, the tap cycle ends on a cleared day.',
    type: 'toggle',
    default: false,
  },
  scoreGranularity: {
    section: 'Statistics',
    label: 'Strength chart resolution',
    help: 'How finely the strength curve is plotted. The score itself is always daily.',
    type: 'select',
    default: 'day',
    options: [
      { value: 'day', label: 'Day' },
      { value: 'week', label: 'Week' },
      { value: 'month', label: 'Month' },
      { value: 'quarter', label: 'Quarter' },
      { value: 'year', label: 'Year' },
    ],
  },
  historyGranularity: {
    section: 'Statistics',
    label: 'History starts on',
    help: 'Which bucket the history chart opens on. You can still switch it per habit.',
    type: 'select',
    // Weeks rather than days: a day-level history of a year is ~365 bars,
    // which reads as noise. Weekly is where the shape of a habit shows.
    default: 'week',
    options: [
      { value: 'day', label: 'Day' },
      { value: 'week', label: 'Week' },
      { value: 'month', label: 'Month' },
      { value: 'quarter', label: 'Quarter' },
      { value: 'year', label: 'Year' },
    ],
  },
  historyMode: {
    section: 'Statistics',
    label: 'History shows',
    help: 'A percentage of days met, or a raw count of completions.',
    type: 'select',
    default: 'percent',
    options: [
      { value: 'percent', label: 'Percentage' },
      { value: 'count', label: 'Count' },
    ],
  },
  notifyChannels: {
    section: 'Notifications',
    label: 'Send reminders to',
    help: 'A habit only sends anything if it has a reminder time set, on its own edit screen.',
    type: 'multi',
    // The phone alarm only. It is the one destination that needs no setup, and
    // the only one that still fires with no network.
    default: ['android'],
    options: CHANNEL_OPTIONS,
  },
  discordChannelId: {
    section: 'Notifications',
    label: 'Discord channel id',
    help: 'For buttons you can answer in Discord. Needs a bot on this server — ' +
      'turn on Developer Mode, then right-click the channel → Copy Channel ID.',
    type: 'text',
    default: '',
    placeholder: '123456789012345678',
    // Hidden until Discord is switched on: an empty field for a destination
    // you are not using reads as something you forgot to fill in.
    requires: (values) => (values.notifyChannels ?? []).includes('discord'),
  },
  discordUserId: {
    section: 'Notifications',
    label: 'Your Discord user id',
    help: 'Optional. Set it and only your clicks count — otherwise anyone who ' +
      'can see the channel can answer your reminders.',
    type: 'text',
    default: '',
    placeholder: '123456789012345678',
    requires: (values) => (values.notifyChannels ?? []).includes('discord') &&
      !!values.discordChannelId,
  },
  discordWebhook: {
    section: 'Notifications',
    label: 'Discord webhook URL',
    help: 'An alternative to the channel id, with no bot to set up — but the ' +
      'message is text only, with nothing to click.',
    type: 'text',
    default: '',
    placeholder: 'https://discord.com/api/webhooks/…',
    requires: (values) => (values.notifyChannels ?? []).includes('discord'),
  },
  notifyTimezone: {
    section: 'Notifications',
    label: 'Reminder timezone',
    help: 'Which clock "08:00" is on. Only affects reminders the server sends; the Android app uses the phone\'s own clock.',
    type: 'select',
    default: '',
    options: timeZoneOptions(),
    // Checked against Intl rather than the option list, so a zone this
    // browser's data does not list — but the server's does — is still shown
    // as the saved value instead of silently reading as the default.
    validate: knownTimeZone,
    requires: (values) => (values.notifyChannels ?? [])
      .some((id) => id !== 'android'),
  },
  confirmDelete: {
    section: 'Safety',
    label: 'Confirm before deleting a habit',
    help: 'Deleting can always be undone from the toast that follows.',
    type: 'toggle',
    default: true,
  },
};

/** @type {Record<string, any> | null} */
let cache = null;

/** Defaults for every declared setting. */
export function defaults() {
  return Object.fromEntries(
    // Arrays are copied: a `multi` default is a mutable value, and handing the
    // registry's own array to the caller means one stray push would change
    // what "default" means for the rest of the session.
    Object.entries(SETTINGS).map(([k, def]) =>
      [k, Array.isArray(def.default) ? [...def.default] : def.default])
  );
}

/** Drop unknown keys and out-of-range values, filling gaps with defaults. */
function sanitise(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (isValid(def, raw[key])) out[key] = raw[key];
  }
  return out;
}

function isValid(def, value) {
  if (value === undefined || value === null) return false;
  if (def.validate) return def.validate(value);
  if (def.type === 'toggle') return typeof value === 'boolean';
  if (def.type === 'select') return def.options.some((o) => o.value === value);
  if (def.type === 'multi') {
    return Array.isArray(value) &&
      value.every((v) => def.options.some((o) => o.value === v));
  }
  // Free text is checked by the server, which is the only check that counts —
  // a webhook URL's real rule (an allowed host) belongs where the fetch is.
  if (def.type === 'text') return typeof value === 'string';
  return false;
}

/**
 * Whether a control applies given the other values, so a dependent field can
 * stay out of the way until it is relevant. A hidden control keeps its stored
 * value; this is about the dialog, not about the data.
 */
export function visible(key, values = load()) {
  const def = SETTINGS[key];
  return !def?.requires || def.requires(values);
}

/* ---------- how the last reminder actually went ---------- */

/**
 * The last delivery outcome per channel, as the server last reported it.
 *
 * @type {{channel: string, ok: boolean, error: string, date: string, at: string}[]}
 */
let deliveryStatus = [];

/**
 * Ask what happened to the last reminder on each destination.
 *
 * The counterpart to the test button below, and the reason it is not enough on
 * its own: a test has to be PRESSED, and nothing suggests pressing it. A
 * webhook deleted months ago stops the reminders while every visible surface —
 * the habit, its time, the destination toggle — goes on looking correct.
 *
 * Never throws. This is a diagnostic bolted onto a dialog that has to open
 * whether or not the request lands.
 */
export async function refreshDelivery() {
  try {
    const res = await fetch('/api/notify/status', { credentials: 'same-origin' });
    if (!res.ok) return deliveryStatus;
    const body = await res.json();
    deliveryStatus = Array.isArray(body?.channels) ? body.channels : [];
  } catch {
    // Offline, or an older server that has no such endpoint. Say nothing
    // rather than claiming a destination is broken because we could not ask.
  }
  return deliveryStatus;
}

/**
 * What to tell the user about a destination that stopped working, or nothing.
 *
 * Reported only for channels currently switched ON: a failure on a destination
 * you have since turned off is not news. The wording after the colon is the
 * sender's own — `postWebhook` and `discordRequest` already say why a 404 is a
 * 404, and a second phrasing here is how the two come to disagree.
 *
 * @param {Record<string, any>} [values] the draft, so turning a channel off
 *   clears its warning without a round trip
 * @returns {string[]}
 */
export function deliveryProblems(values = load()) {
  const enabled = new Set(values.notifyChannels ?? []);
  const label = (id) =>
    CHANNEL_OPTIONS.find((o) => o.value === id)?.label.replace(/\s*\(.*\)$/, '') ?? id;

  return deliveryStatus
    .filter((s) => !s.ok && enabled.has(s.channel))
    .map((s) => {
      const when = s.date ? ` on ${s.date}` : '';
      return `${label(s.channel)} — the last reminder${when} was not delivered: ` +
        `${s.error || 'no reason was given'}.`;
    });
}

/**
 * Things a section has to SAY, as opposed to things it can do.
 *
 * Declared here for the same reason `SECTION_ACTIONS` is: the dialog renders a
 * section without knowing what is in it. Each entry takes the draft and returns
 * lines of prose, or nothing when there is nothing wrong.
 *
 * @type {Record<string, (values: Record<string, any>) => string[]>}
 */
export const SECTION_NOTICES = {
  Notifications: deliveryProblems,
};

/**
 * Buttons a section needs that are not settings.
 *
 * Declared here rather than hardcoded in app.js for the same reason SETTINGS
 * is: the dialog should be able to render a whole section without knowing what
 * is in it. `run` resolves to the text to show the user.
 *
 * @type {Record<string, {label: string, run: () => Promise<string>}[]>}
 */
export const SECTION_ACTIONS = {
  Notifications: [{
    label: 'Send a test notification',
    /**
     * Ask the server to post to every destination it delivers for.
     *
     * This is the only way to find out that a webhook URL is wrong: a
     * reminder that fails at 08:00 fails silently into a server log, which is
     * exactly where nobody is looking.
     */
    async run() {
      const res = await fetch('/api/notify/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `test failed (${res.status})`);

      const results = body.results ?? [];
      if (!results.length) {
        return 'No server-delivered destination is switched on and configured.';
      }
      return results
        .map((r) => (r.ok ? `${r.channel}: sent` : `${r.channel}: ${r.error}`))
        .join(' · ');
    },
  }],
};

function readCache() {
  try {
    return sanitise(JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}'));
  } catch {
    return defaults();          // corrupt value: fall back rather than throw
  }
}

function writeCache(values) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(values));
  } catch {
    // Private browsing or a full quota; the server copy still stands.
  }
}

/**
 * Load preferences from the server, falling back to the cached copy when
 * offline or signed out. Call once at startup, before the first render.
 */
export async function init() {
  cache = readCache();          // so a slow request never flashes defaults
  try {
    const res = await fetch('/api/settings', { credentials: 'same-origin' });
    if (res.ok) {
      cache = sanitise(await res.json());
      writeCache(cache);
    }
  } catch {
    // Offline: keep the cached values.
  }
  return cache;
}

/** All settings. Synchronous, so render paths need no await. */
export function load() {
  if (!cache) cache = readCache();
  return cache;
}

/** One setting's current value. */
export function get(key) {
  return load()[key];
}

/** @type {((values: Record<string, any>) => void)[]} */
const listeners = [];

/**
 * Called when the cached values change because the SERVER said something
 * different from what was sent. Used by the settings dialog to redraw.
 */
export function onChange(fn) {
  listeners.push(fn);
}

/**
 * Take the server's word for it.
 *
 * The reply to a write is authoritative, and it is not always what was sent:
 * a webhook URL comes back without its query string, and a channel list comes
 * back deduplicated and in registry order. Without adopting it, the cache
 * disagrees with the server until the next reload — the dialog then shows a
 * value the server does not hold, which is the failure this whole
 * "server wins, localStorage caches" arrangement exists to avoid.
 *
 * The two editions answer slightly differently (one returns the accepted
 * patch, the other the whole merged object); merging covers both.
 */
function adopt(serverValues) {
  if (!serverValues || typeof serverValues !== 'object') return;
  const merged = sanitise({ ...load(), ...serverValues });
  if (JSON.stringify(merged) === JSON.stringify(load())) return;

  cache = merged;
  writeCache(cache);
  for (const fn of listeners) {
    try { fn(cache); } catch { /* a listener must not break a save */ }
  }
}

/** Queue a write for later, so a choice made offline still reaches the server. */
async function queueWrite(body) {
  try {
    const { enqueue } = await import('/shared/offline.js');
    await enqueue({ url: '/api/settings', method: 'PUT', body });
  } catch {
    // No outbox available; the cached value still applies here.
  }
}

/**
 * Persist one setting.
 *
 * Applies locally first so the UI responds immediately, then writes through
 * to the server. A failed write leaves the value cached for this device and
 * is retried on the next `init()`.
 *
 * For a value only the server can judge — a webhook URL — use `save`, which
 * waits for the answer.
 *
 * @returns {boolean} whether the value was accepted locally
 */
export function set(key, value) {
  const def = SETTINGS[key];
  if (!def || !isValid(def, value)) return false;

  cache = { ...load(), [key]: value };
  writeCache(cache);

  const body = JSON.stringify({ [key]: value });
  fetch('/api/settings', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).then(async (res) => {
    if (!res.ok) return;
    const payload = await res.json().catch(() => null);
    adopt(payload?.settings);
  }).catch(async () => {
    // Offline. Queue the write so the choice reaches the server rather than
    // living on this device only — otherwise a preference set on a train
    // silently fails to follow the account.
    await queueWrite(body);
  });

  return true;
}

/**
 * Persist one setting and wait for the server's verdict.
 *
 * Some values cannot be judged here. A Discord webhook URL is only legal if it
 * points at a host the server is willing to fetch, and that rule lives with
 * the fetch — duplicating it in the browser is how the two would drift. So the
 * control has to be able to say "that was refused" and show what is actually
 * stored, which needs the round trip.
 *
 * @returns {Promise<{ok: boolean, value?: any, error?: string, offline?: boolean}>}
 */
export async function save(key, value) {
  const def = SETTINGS[key];
  if (!def) return { ok: false, error: 'unknown setting' };

  const body = JSON.stringify({ [key]: value });
  let res;
  try {
    res = await fetch('/api/settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch {
    // Offline: keep it here and send it later. Accepting it locally is the
    // lesser evil — the alternative is silently discarding what was typed.
    if (!isValid(def, value)) return { ok: false, error: 'not a valid value' };
    cache = { ...load(), [key]: value };
    writeCache(cache);
    await queueWrite(body);
    return { ok: true, value, offline: true };
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: payload.error ?? `could not save (${res.status})` };
  }
  if ((payload.ignored ?? []).includes(key)) {
    return { ok: false, error: 'the server would not accept that value' };
  }

  adopt(payload.settings);
  return { ok: true, value: get(key) };
}

/**
 * Persist several settings at once and wait for the server's verdict.
 *
 * The settings dialog holds a draft and writes it when Done is pressed, so it
 * needs one round trip rather than one per control — and one verdict, since
 * the answer to "was that accepted?" is the same shape for nine keys as for
 * one. The server ignores what it will not take rather than failing the whole
 * patch, so this reports `ignored` and the caller shows what was *stored*:
 * a webhook URL that snaps back to blank is how the user learns it was
 * refused, instead of finding out at 08:00 tomorrow.
 *
 * @param {Record<string, any>} patch
 * @returns {Promise<{ok: boolean, ignored: string[], error?: string, offline?: boolean}>}
 */
export async function saveAll(patch) {
  const keys = Object.keys(patch).filter((key) => SETTINGS[key]);
  if (!keys.length) return { ok: true, ignored: [] };

  const body = JSON.stringify(Object.fromEntries(keys.map((k) => [k, patch[k]])));

  let res;
  try {
    res = await fetch('/api/settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch {
    // Offline: keep what this browser can judge and send it later, exactly as
    // `save` does. Anything only the server can rule on is accepted here too —
    // discarding what was typed is the worse of the two wrongs, and the queued
    // write still gets the real verdict.
    const accepted = {};
    for (const key of keys) {
      if (isValid(SETTINGS[key], patch[key])) accepted[key] = patch[key];
    }
    cache = { ...load(), ...accepted };
    writeCache(cache);
    await queueWrite(body);
    return {
      ok: true,
      ignored: keys.filter((key) => !(key in accepted)),
      offline: true,
    };
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      ignored: [],
      error: payload.error ?? `could not save (${res.status})`,
    };
  }

  adopt(payload.settings);
  return { ok: true, ignored: payload.ignored ?? [] };
}

/** Restore every setting to its default, on the server and locally. */
export async function reset() {
  cache = defaults();
  writeCache(cache);
  try {
    await fetch('/api/settings', { method: 'DELETE', credentials: 'same-origin' });
  } catch { /* offline; defaults still apply here */ }
  return cache;
}

/** Section names in declaration order, for rendering the dialog. */
export function sections() {
  const seen = [];
  for (const def of Object.values(SETTINGS)) {
    const s = def.section ?? 'General';
    if (!seen.includes(s)) seen.push(s);
  }
  return seen;
}
