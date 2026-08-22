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
 * @property {'select'|'toggle'|'multi'|'ordered-multi'|'text'} type
 * @property {any} default
 * @property {{value: string, label: string, onEnable?: () => any}[]} [options]
 *   for `select`, `multi` and `ordered-multi`. `onEnable` runs when a `multi`
 *   option is TICKED, inside the click that ticked it — the settings dialog is
 *   the only place in the app with a user gesture to spend, and a notification
 *   permission cannot be asked for without one. Return a promise and the
 *   dialog redraws when it settles, so the section can report what the
 *   browser answered.
 * @property {string} [placeholder]  for `text`
 * @property {string} [section]  groups controls in the dialog
 * @property {(values: Record<string, any>) => boolean} [requires]
 *   when present, the control is only shown while this holds — a webhook URL
 *   is noise until its channel is switched on
 * @property {(value: any) => boolean} [validate]
 *   overrides the type's own check, for a value whose legal set is not a list
 * @property {(raw: any) => any} [normalise]
 *   for `ordered-multi`: an independent mirror of the server's normaliser
 *   (`parseCardList` for `detailCards`), needed because `sanitise` runs in the
 *   browser and `shared/src` is not served there — the same reason
 *   `DETAIL_CARDS` is declared twice. Must answer `undefined` for `undefined`,
 *   so an absent key still falls through to `defaults()` rather than the
 *   normaliser inventing a value. Runs before `isValid`.
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
  // The label carries the whole truth about what this destination is, because
  // the alternative is a bug report in six months: it cannot wake you at 08:30
  // and nothing in a browser can — see the module comment in ui/nudge.js.
  { value: 'web',
    label: 'This browser (when you open the app, not at a set time)',
    // A permission prompt only counts if it comes from a user GESTURE, and
    // ticking this box is one. Asked here rather than on boot for exactly that
    // reason: a page that asks on load is asking before there is anything to
    // ask about, and browsers increasingly refuse such a prompt outright — after
    // which the destination can never be granted from this app at all.
    //
    // The answer is not read here. `browserNudgeProblems` below reports
    // whatever the browser ended up saying, including the one answer script
    // cannot undo.
    onEnable: () => globalThis.Notification?.requestPermission?.() },
  { value: 'discord', label: 'Discord channel (sent by the server)' },
  { value: 'ntfy', label: 'ntfy topic (sent by the server; buttons need a public server address)' },
];

/**
 * Destinations the DEVICE decides, mirroring `delivery: 'device'` in
 * shared/src/notify.js.
 *
 * Only `notifyTimezone`'s `requires` needs it, and it needs it to be right: that
 * setting says which clock the SERVER's "08:00" is on, and neither of these is
 * the server's. Offering the control because one of them is switched on is a
 * preference that governs nothing, in the section where "why am I not getting
 * my reminders?" is answered.
 */
const DEVICE_CHANNELS = ['android', 'web'];

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
  // 'auto' = follow whichever device last checked in, and it is the DEFAULT —
  // so omitting it made the registry's own default fail its own validator.
  // Invisible online, because `sanitise` throws the invalid value away and
  // substitutes the default, which is the same string. Offline it was not:
  // `saveAll` reported `ignored: ['notifyTimezone']`, the dialog toasted
  // "Not saved: Reminder timezone" and redrew the old value — while the offline
  // branch had already queued a write body containing `auto`, which landed on
  // reconnect. Told it did not save, shown the old value, and it saved anyway.
  if (value === 'auto') return true;
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
    { value: 'auto', label: 'Automatic — follow this device' },
    { value: '', label: "Server's own clock" },
    ...zones.map((zone) => ({
      value: zone,
      label: zone === device ? `${zone} (this device)` : zone,
    })),
  ];
}

/**
 * Which cards `ui/detail.js` draws, and in what order — the `detailCards`
 * def's `normalise`.
 *
 * An independent mirror of `parseCardList` in shared/src/validate.js, not a
 * call to it: `shared/src` is not served to the browser, the same reason
 * `DETAIL_CARDS` is declared twice. The canonical order comes from
 * `SETTINGS.detailCards.options`, so it is not a THIRD declaration of the
 * nine ids — only of the rule that reads them. See that function's JSDoc for
 * the two input shapes (LEGACY: every element a string, or `[]`; NEW: every
 * element an `{id, on}` object) and why a mix of the two refuses rather than
 * guesses. LEGACY carries no order of its own to honour — master's own
 * `parseCardList` was `DETAIL_CARDS.filter((id) => raw.includes(id))`, so
 * every legacy value that can be in storage is already a canonical-order
 * subset, and reading the order the caller happened to list ids in would
 * silently rearrange the page the first time one card was re-ticked.
 *
 * @param {unknown} raw
 * @returns {{id: string, on: boolean}[]|undefined}
 */
function normaliseDetailCards(raw) {
  if (!Array.isArray(raw)) return undefined;
  const order = SETTINGS.detailCards.options.map((o) => o.value);
  if (raw.length > order.length * 4) return undefined;   // obvious junk

  const isCardObject = (el) => el !== null && typeof el === 'object' &&
    typeof el.id === 'string';

  if (raw.length === 0 || raw.every((el) => typeof el === 'string')) {
    // A legacy value carries no order — see the module comment above — so
    // this is membership alone, in canonical (`order`) order. `order.includes`
    // rather than a Set: `raw` is already capped to `order.length * 4` above,
    // and a repeated or unknown id in it needs no separate handling either —
    // it simply matches nothing extra.
    return order.map((id) => ({ id, on: raw.includes(id) }));
  }

  if (raw.every(isCardObject)) {
    const seen = new Set();
    const kept = [];
    for (const el of raw) {
      if (order.includes(el.id) && !seen.has(el.id)) {
        seen.add(el.id);
        kept.push({ id: el.id, on: !!el.on });
      }
    }
    for (const id of order) {
      if (seen.has(id)) continue;
      const predecessorIndex = order.indexOf(id) - 1;
      let insertAt = 0;
      if (predecessorIndex >= 0) {
        const foundAt = kept.findIndex((c) => c.id === order[predecessorIndex]);
        if (foundAt !== -1) insertAt = foundAt + 1;
      }
      kept.splice(insertAt, 0, { id, on: true });
      seen.add(id);
    }
    return kept;
  }

  return undefined;   // mixed strings and objects — no legitimate client sends this
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
  theme: {
    section: 'Dashboard',
    label: 'Theme',
    help: 'Light, dark, or whatever this device is set to.',
    type: 'select',
    // `system` rather than a light/dark pair, because "follow the device" is a
    // state and not the absence of one. The old two-way toggle wrote
    // localStorage, so pressing it once was irreversible: there was no way back
    // to following the system, and a machine that goes dark at sunset stopped
    // doing so with nothing on screen to say why.
    default: 'system',
    options: [
      { value: 'system', label: 'Follow this device' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  },
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
  groupByCategory: {
    section: 'Dashboard',
    label: 'Group by category',
    help: 'Draw one section per category, with an Uncategorised section last.',
    type: 'toggle',
    // False by default: a new install has no categories, and a grouped list
    // with one section (Uncategorised, holding everything) is strictly worse
    // than the flat list it would replace.
    default: false,
  },
  gridDays: {
    section: 'Dashboard',
    label: 'Day columns',
    // Says "at most" in the help, because that is what it is: `gridColumns` in
    // ui/window.js takes the smaller of this and what the viewport fits, so a
    // phone asked for fourteen still draws seven. Without the sentence the
    // setting looks broken on the device most of this app is used on.
    help: 'How many days the dashboard grid shows at most. Fewer are drawn ' +
      'when the screen is too narrow for the number you pick.',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Fit the screen (7, 10 or 14)' },
      { value: '5', label: '5 — biggest targets' },
      { value: '7', label: '7 — a week' },
      { value: '10', label: '10' },
      { value: '14', label: '14 — a fortnight' },
    ],
  },
  weekStart: {
    section: 'Dashboard',
    label: 'Week starts on',
    help: 'Which day a week begins on, everywhere: the calendar, its weekday ' +
      'rows and keys, the history buckets and both by-weekday charts.',
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
  atMostUnlogged: {
    section: 'Tracking',
    label: 'On an “at most” habit, a day you never logged',
    help: 'A limit — at most 2 coffees, no smoking — is the one kind where ' +
      'saying nothing could mean either thing: zero is under the limit. ' +
      'Recording a clean day is one tap, and a day you did record as 0 ' +
      'counts as staying under whichever you pick.',
    type: 'select',
    // `miss`, so a limit created today does not arrive with a perfect record
    // it has not had time to earn. `test/settings.test.js` pins this against
    // `UNLOGGED_DEFAULT` in stats.js, which is what actually decides.
    default: 'miss',
    options: [
      { value: 'miss', label: 'Counts as a miss' },
      { value: 'success', label: 'Counts as staying under' },
    ],
  },
  numberFormat: {
    section: 'Tracking',
    label: 'Decimal separator',
    help: 'How you write numbers, where an amount is typed. It decides whether ' +
      '“10.000” is ten or a thousands separator this app will not guess at, ' +
      'and the box writes amounts back the same way.',
    type: 'select',
    // `auto` resolves against this device at the moment something is parsed,
    // and is a stored value rather than the absence of one — the same shape as
    // `theme: 'system'` above and `notifyTimezone: 'auto'` below, for the same
    // reason: what the device reports must not silently become what the account
    // has decided. See `resolveNumberFormat` in ui/amount.js.
    default: 'auto',
    options: [
      { value: 'auto', label: 'Follow this device' },
      { value: 'point', label: 'Point — 1234.5' },
      { value: 'comma', label: 'Comma — 1234,5' },
    ],
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
  detailCards: {
    section: 'Statistics',
    label: 'Cards on a habit’s page',
    help: 'A card with nothing in it yet is hidden whatever you choose here. ' +
      'The four figures at the top of the page are always shown.',
    type: 'ordered-multi',
    // All of them, on: this is a way to make the page shorter and reorder it,
    // not a page you have to assemble before it says anything.
    //
    // The ids and their ORDER mirror `DETAIL_CARDS` in shared/src/validate.js,
    // which the browser cannot import — and the order is load bearing, not
    // tidiness: `parseCardList` stores a NEW-SHAPE list close to verbatim, so
    // a default written in any other order would be normalised away on its
    // first write. `recentDays` is FIRST — it is the only card you ACT on
    // rather than read, and the reason it exists is arriving from a reminder
    // and wanting to answer without hunting for the calendar. `calendar`
    // immediately follows `strength` (sits directly under the score) and
    // `awards` comes after `resilience` (a probability you can act on beats a
    // trophy); test/settings.test.js pins all three.
    default: [
      { id: 'recentDays', on: true },
      { id: 'strength', on: true },
      { id: 'calendar', on: true },
      { id: 'streaks', on: true },
      { id: 'resilience', on: true },
      { id: 'awards', on: true },
      { id: 'history', on: true },
      { id: 'weekdays', on: true },
      { id: 'weekdayMonths', on: true },
      { id: 'frequency', on: true },
    ],
    normalise: normaliseDetailCards,
    // The labels are the card titles as they appear on the page, so the dialog
    // and the page name the same thing. Unchanged in shape and order — only
    // `default` and `type` above express the new stored shape.
    options: [
      { value: 'recentDays', label: 'Recent days' },
      { value: 'strength', label: 'Habit strength' },
      { value: 'calendar', label: 'Calendar' },
      { value: 'streaks', label: 'Best streaks' },
      { value: 'resilience', label: 'Bouncing back' },
      { value: 'awards', label: 'Awards' },
      { value: 'history', label: 'History' },
      { value: 'weekdays', label: 'By day of week' },
      { value: 'weekdayMonths', label: 'Weekday consistency' },
      { value: 'frequency', label: 'Times per week' },
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
    help: 'A habit only sends anything if it has a reminder time set, on its own ' +
      'edit screen. This browser is the exception to the times: it tells you what ' +
      'is still outstanding when you open the app, and cannot wake you.',
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
  ntfyTopicUrl: {
    section: 'Notifications',
    label: 'ntfy topic URL',
    help: 'Where reminders are published. Subscribe to the same topic in the ' +
      'ntfy app. This server only posts to hosts its operator allows, so a URL ' +
      'that snaps back to blank is one it has not been permitted to reach. ' +
      'Buttons to answer from need this server to have a public address ' +
      'configured — without one, a reminder still arrives with nothing to ' +
      'press. Once buttons are on, anyone who can see this topic can answer ' +
      'these reminders, not just read them — worse on public ntfy.sh, which ' +
      'has no per-topic access control.',
    type: 'text',
    default: '',
    placeholder: 'https://ntfy.sh/my-habits',
    requires: (values) => (values.notifyChannels ?? []).includes('ntfy'),
  },
  ntfyToken: {
    section: 'Notifications',
    label: 'ntfy access token',
    help: 'Only for a protected topic — leave it empty for a public one.',
    type: 'text',
    default: '',
    placeholder: 'tk_…',
    requires: (values) => (values.notifyChannels ?? []).includes('ntfy'),
  },
  notifyTimezone: {
    section: 'Notifications',
    label: 'Reminder timezone',
    help: 'Which clock "08:00" is on. Only affects reminders the server sends; '
      + 'the Android app uses the phone\'s own clock. Following your device '
      + 'means a reminder travels with you; name a zone to keep it on home time.',
    type: 'select',
    // `auto` rather than `''`: "follow whichever device I last used" is a
    // state, not the absence of one, and it has to stay tellable apart from a
    // zone the user CHOSE — see AUTO_ZONE in shared/src/notify.js. `''` keeps
    // its old meaning, so an account that deliberately picked the server's
    // clock keeps it, and one that never touched the setting gets `auto`.
    default: 'auto',
    options: timeZoneOptions(),
    // Checked against Intl rather than the option list, so a zone this
    // browser's data does not list — but the server's does — is still shown
    // as the saved value instead of silently reading as the default.
    validate: knownTimeZone,
    requires: (values) => (values.notifyChannels ?? [])
      .some((id) => !DEVICE_CHANNELS.includes(id)),
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
    // Arrays are copied: a `multi` or `ordered-multi` default is a mutable
    // value, and handing the registry's own array to the caller means one
    // stray push would change what "default" means for the rest of the
    // session. `structuredClone` rather than `[...def.default]`, because
    // `detailCards`'s default now holds OBJECTS — a shallow copy shares every
    // element with the registry's own default, and one stray `entry.on =
    // false` on a caller's copy would flip it there too.
    Object.entries(SETTINGS).map(([k, def]) =>
      [k, Array.isArray(def.default) ? structuredClone(def.default) : def.default])
  );
}

/** Drop unknown keys and out-of-range values, filling gaps with defaults. */
function sanitise(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, def] of Object.entries(SETTINGS)) {
    // `normalise` runs first, exactly as the server's own normaliser-form
    // rules in SETTING_VALUES do — so `isValid` below is checking the
    // normaliser's OUTPUT, which catches a bug in the normaliser rather than
    // merely rejecting a stale stored value. A def WITH a normaliser is
    // validated on what it answers, refusal included — `??` here would let a
    // normaliser's `undefined` (a refusal) fall back to the raw,
    // unnormalised value and hand `isValid` something the normaliser never
    // approved. A def with no normaliser is validated on the raw value, as
    // before.
    const value = def.normalise ? def.normalise(raw[key]) : raw[key];
    if (isValid(def, value)) out[key] = value;
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
  if (def.type === 'ordered-multi') {
    // Strict: an array holding every option exactly once, each entry an
    // object with a known id and a boolean `on`. Strict on purpose — the
    // normaliser has already run by the time this is asked, so a value that
    // fails here is a normaliser bug rather than a legacy shape to tolerate.
    if (!Array.isArray(value) || value.length !== def.options.length) return false;
    const seen = new Set();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') return false;
      if (typeof entry.on !== 'boolean') return false;
      if (!def.options.some((o) => o.value === entry.id)) return false;
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
    }
    return true;
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
      // "since", not "on". The stored date is when this state BEGAN, because
      // the row is only rewritten when the reason changes — a failure that has
      // persisted for a week still carries the date it started. Saying "the
      // last reminder on <date>" would be a claim the data does not support.
      const when = s.date ? ` since ${s.date}` : '';
      return `${label(s.channel)} — reminders have not been delivered${when}: ` +
        `${s.error || 'no reason was given'}.`;
    });
}

/**
 * What to tell the user about this browser's own permission, or nothing.
 *
 * The counterpart of `deliveryProblems` for the one destination the SERVER
 * knows nothing about. `channelConfigured` says `web` is always configured —
 * there are no keys to set — so without this a browser that refused the prompt
 * would show a destination switched on, correct in every visible respect, and
 * silent except for an in-app line nobody expects.
 *
 * `denied` is the state that makes this necessary rather than nice. It cannot
 * be recovered from script: `requestPermission()` on a denied origin resolves
 * `denied` again without showing anything, so pressing the box a second time is
 * a control that does nothing. The only way back is the browser's own site
 * settings, and this is the only place that can say so.
 *
 * Read from the browser at render time and not from a cached value, because the
 * user may have gone and changed it in another tab — and reported only while
 * the destination is switched ON, exactly as a delivery failure is.
 *
 * @param {Record<string, any>} [values] the draft
 * @returns {string[]}
 */
export function browserNudgeProblems(values = load()) {
  if (!(values.notifyChannels ?? []).includes('web')) return [];

  // Asked FIRST, because on a non-secure origin the permission answers
  // `denied` and cannot be anything else — so every branch below it would give
  // advice that cannot work. Measured on `http://192.168.50.232:3249`:
  // `isSecureContext` false, `typeof Notification === 'function'`,
  // `permission === 'denied'`, `requestPermission()` resolving `denied`
  // without a prompt, and `navigator.serviceWorker` undefined. Sending that
  // user to their site settings is the one surface written to explain the
  // silence, explaining it wrongly.
  //
  // It is the LAN half of `HABITERALL_UPGRADE_INSECURE` and not an exotic
  // deployment: https from outside, plain http from inside, same database, and
  // the root CLAUDE.md names it. `=== false` rather than falsy, so a runtime
  // that does not define the flag at all (Node, an old browser) falls through
  // to the permission questions instead of being told its origin is the
  // problem.
  if (globalThis.isSecureContext === false) {
    return ['This page was loaded over plain http, and browsers only allow ' +
      'notifications on a secure origin — no site setting can change that. ' +
      'Reach this app over https (or via localhost) for notifications; until ' +
      'then, anything still outstanding is shown inside the app.'];
  }

  // Read straight off the platform. This is not a mirrored RULE — there is
  // nothing here to drift from — it is one browser being asked about itself,
  // and `ui/nudge.js` asks it again at the moment it has something to show.
  const permission = globalThis.Notification?.permission;

  if (typeof permission !== 'string') {
    return ['This browser cannot show notifications, so anything still ' +
      'outstanding is shown inside the app instead.'];
  }
  if (permission === 'denied') {
    return ['This browser is blocking notifications for this site, and it ' +
      'cannot be asked again from here — allow them in the browser\'s own site ' +
      'settings. Until then, anything still outstanding is shown inside the app.'];
  }
  if (permission !== 'granted') {
    return ['Notifications are not allowed yet, so anything still outstanding ' +
      'is shown inside the app. Switch this destination off and on again to be ' +
      'asked.'];
  }
  return [];
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
  // Two questions, one section, and they are answered by different things: the
  // server reports how the last send went, and the browser reports whether it
  // will show anything at all. Composed here rather than as two entries because
  // the dialog renders one list of notices per section.
  Notifications: (values) => [...deliveryProblems(values), ...browserNudgeProblems(values)],
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

/**
 * @param {Record<string, any>} values
 * @param {import('./settings.js').ApplyMeta} [meta]
 */
function writeCache(values, meta) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(values));
  } catch {
    // Private browsing or a full quota; the server copy still stands.
  }
  // After the store, and outside its try: a setting the browser APPLIES to
  // itself has to follow the value whether or not localStorage would take it.
  //
  // Each one guarded, for the reason `adopt`'s listener loop gives two
  // functions down — "a listener must not break a save". This loop sits on the
  // chokepoint EVERY write goes through, so without it an applier that threw
  // turned a successful server write into a rejected `save()` or `set()`,
  // and `app.js`'s theme handler has no `.catch()`, so it would be an
  // unhandled rejection with no toast.
  notifyAppliers(values, meta);
}

/**
 * Hand the values to everything that paints itself from them.
 *
 * `meta.stored` is the server's OWN reply — the keys it says it holds, before
 * `sanitise` fills the gaps — and it is present only when this update came
 * from a response. That distinction cannot be recovered downstream and one
 * applier genuinely needs it: `ui/theme.js` keeps a durable note of what this
 * device last said, and the only thing that may retire that note is the server
 * confirming it. A cache write is not confirmation; an offline save performs
 * one, which is how a press made on a train was undone by reopening the app.
 *
 * Guarded for the reason the loop it replaced was: this runs on the chokepoint
 * every write goes through, so an applier that throws must not turn a
 * successful server write into a rejected `save()`.
 */
/**
 * The server's own value for every key it has ever told us about, held RAW —
 * before `sanitise` fills a gap or a normaliser rewrites it. Read only by
 * `storedShapeIsStale`, below. Updated here rather than in `writeCache`,
 * because `reset()` calls `notifyAppliers` directly with its own `meta` —
 * this is the one point every path carrying an `ApplyMeta.stored` passes
 * through.
 *
 * A `full` reply REPLACES this rather than merging into it: it is the
 * account's WHOLE state, so a key missing from one is a key the account no
 * longer holds (this is what makes `reset()` retire a stale flag rather than
 * leaving it stuck stale forever). A partial reply — a single `save`/
 * `saveAll`'s accepted patch — only ADDS to what is known, since it says
 * nothing about a key it does not mention.
 *
 * @type {Record<string, unknown>}
 */
let lastServerStored = {};

/**
 * @param {Record<string, any>} values
 * @param {ApplyMeta} [meta]
 */
function notifyAppliers(values, meta) {
  if (meta?.stored && typeof meta.stored === 'object') {
    lastServerStored = meta.full ? { ...meta.stored } : { ...lastServerStored, ...meta.stored };
  }
  for (const fn of appliers) {
    try {
      fn(values, meta);
    } catch {
      /* an applier must not break a save either */
    }
  }
}

/**
 * Whether the account's OWN stored value for `key` is in a shape its
 * normaliser would rewrite — i.e. whether there is a legacy value left for a
 * Save to migrate.
 *
 * Generic over `def.normalise`, not a `detailCards` special case: the
 * question "the server holds a value my normaliser would rewrite" is the
 * general one, and a special case here would have to be found and rewritten
 * by whoever adds the second normaliser.
 *
 * Only a value the SERVER named counts. `lastServerStored` is built solely
 * from `ApplyMeta.stored`, never from `load()` — the localStorage cache and a
 * merge are already in the new shape by the time anything reads them (both go
 * through `sanitise`), and asking `load()` here would report that as staleness
 * that is not there. An absent key answers false: an account that has never
 * stored `key` has nothing to migrate, and answering true for it would make
 * every fresh account write its defaults back on its very first Save.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function storedShapeIsStale(key) {
  const def = SETTINGS[key];
  if (!def?.normalise) return false;
  if (!Object.hasOwn(lastServerStored, key)) return false;
  const raw = lastServerStored[key];
  const normalised = def.normalise(raw);
  // The normaliser refusing the stored value outright is not this predicate's
  // question to answer — there is no shape to migrate TO.
  if (normalised === undefined) return false;
  return JSON.stringify(raw) !== JSON.stringify(normalised);
}

/**
 * @typedef {{stored?: Record<string, unknown>, full?: boolean, wrote?: string[]}} ApplyMeta
 *   `stored` is the server's own reply — the keys it names, before `sanitise`
 *   fills the gaps — and is present only when the update came from a response
 *   rather than from a cache write. `full` says that reply was the account's
 *   WHOLE state (the boot GET) rather than one write's accepted patch, which
 *   is the only thing that can answer "does the account hold this key at all".
 *   `wrote` is the keys THIS DEVICE just sent, which is not recoverable from
 *   `stored`: the cloud edition answers a write with the whole blob, so a
 *   reply naming `theme` says nothing about whether this write was about it.
 *   `ui/theme.js` needs the difference — a local write that named the theme
 *   is newer than an unconfirmed press, and one that did not is not.
 */
/** @type {((values: Record<string, any>, meta?: ApplyMeta) => void)[]} */
const appliers = [];

/**
 * Follow a setting the browser applies to ITSELF, rather than reading at render
 * time.
 *
 * Distinct from `onChange`, which fires only when the server disagreed with
 * what was sent — that is the dialog's cue to redraw, and it says nothing about
 * an ordinary save. A theme has to follow every path the cache moves by: the
 * first read from localStorage, the answer to `init()`, a `set`, a `save`, a
 * `saveAll` and a `reset`. Six call sites, or one chokepoint, and `writeCache`
 * is already on all six.
 *
 * The callback is invoked immediately with the values in hand, because the
 * caller registering before the first paint is the whole point.
 */
/**
 * How long a settings request may take before it counts as unreachable.
 *
 * Taken from `ui/api.js`'s bound rather than invented, because it is the same
 * question — and these calls do NOT go through `api()`, which is how they came
 * to have no bound at all. Measured: a PUT accepted and never answered (a
 * stale tunnel, a container that has stopped replying) left `save()` pending
 * indefinitely, so a caller awaiting it waited forever and the write reached
 * neither the server nor the outbox. Chrome imposes no ceiling of its own.
 *
 * A settings write is a patch of key to value, so it is safe to arrive twice —
 * which is what makes abandoning one and queueing it a sound answer, where
 * `POST /habits` would yield a second habit. See `replayable()` in ui/api.js.
 */
const REQUEST_MS = 10_000;

/**
 * An abort signal for one request.
 *
 * `AbortSignal.timeout` is Chrome 103 / Firefox 100 / Safari 16, and returning
 * `undefined` below it does not degrade gracefully — `ui/theme.js` serialises
 * its writes, so ONE unbounded link wedges every write after it for the life of
 * the page. `offline.js`'s `isReachable` already hand-rolls this; so does this.
 */
const bound = () => {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return AbortSignal.timeout(REQUEST_MS);
  }
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')),
             REQUEST_MS);
  return controller.signal;
};

/**
 * Did this request run out of time, rather than fail to leave the machine?
 *
 * The difference decides whether the write is QUEUED, and getting it wrong is
 * a data loss with no offline state anywhere near it. Aborting does not recall
 * a request the server may already have begun, so an abandoned write is of
 * unknown outcome — filing it in the outbox means replaying it later, over
 * whatever the user has done since. Measured: a press whose write was
 * black-holed, then a second press that succeeded, and the next boot painted
 * the FIRST value because the outbox replayed it. A genuine network failure is
 * different: nothing left, so nothing can have landed, and queueing is right.
 *
 * @param {unknown} err
 */
const timedOut = (err) =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

export function onApply(fn) {
  appliers.push(fn);
  // Guarded like the loop in `writeCache`, and for the same reason: this is a
  // registration made during boot, so a throw here escapes `start()` and takes
  // the whole app to the error view over a preference that failed to paint.
  try {
    fn(load());
  } catch {
    /* an applier must not break the boot either */
  }
}

/**
 * Load preferences from the server, falling back to the cached copy when
 * offline or signed out. Call once at startup, before the first render.
 */
export async function init() {
  cache = readCache();          // so a slow request never flashes defaults
  try {
    const res = await fetch('/api/settings',
      { credentials: 'same-origin', signal: bound() });
    if (res.ok) {
      // The RAW reply travels with the sanitised one. `sanitise` fills every
      // gap from `defaults()`, so by the time it is cache the difference
      // between "the account is set to follow the device" and "the account has
      // never had a theme" is gone — and that difference is the whole of what
      // `ui/theme.js` needs to know here. It used to re-ask this same route
      // after boot to recover it.
      const stored = await res.json();
      cache = sanitise(stored);
      // `full: true` — this reply is the account's WHOLE state, which a PUT's
      // is not. The personal edition answers a write with the accepted PATCH
      // (`res.json({settings: accepted})`), so a reply that does not mention
      // `theme` means "this write did not set one", never "the account has
      // none". Read as the latter it let a device push its own pre-setting
      // theme over an account another device had already set — on a write
      // about the calendar zoom. Cloud returns the whole blob, so the bug was
      // one edition only, which is worse rather than better: the rule has to
      // hold for both.
      writeCache(cache, stored && typeof stored === 'object'
        ? { stored, full: true } : undefined);
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
function adopt(serverValues, wrote = []) {
  if (!serverValues || typeof serverValues !== 'object') return;
  const merged = sanitise({ ...load(), ...serverValues });
  if (JSON.stringify(merged) === JSON.stringify(load())) {
    // Nothing MOVED, and the appliers are still told — because "the server
    // holds this value" is news even when it is the value we already had. It
    // is what retires `ui/theme.js`'s device note, and the commonest shape of
    // that is a press whose write the server accepts unchanged.
    notifyAppliers(load(), { stored: serverValues, wrote });
    return;
  }

  cache = merged;
  writeCache(cache, { stored: serverValues, wrote });
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
    signal: bound(),
  }).then(async (res) => {
    if (!res.ok) return;
    const payload = await res.json().catch(() => null);
    // `[key]`, exactly as `save` and `saveAll` pass theirs. `wrote` is how an
    // applier tells "the account says this" from "this device just said this",
    // and defaulting it to `[]` here says the write came from somewhere else —
    // so an in-place control for a key any applier watches would reinstate the
    // defect `reconcile`'s `wrote` check exists to prevent. No caller uses
    // `set` for such a key today, which is exactly why it is worth being right
    // about now rather than at the point one does.
    adopt(payload?.settings, [key]);
  }).catch(async (err) => {
    // Out of time is not offline, and this one is fire-and-forget: nobody is
    // waiting to be told, so an abandoned write is simply dropped rather than
    // queued to replay over whatever the user does next.
    //
    // Note this covers EVERY key `set` writes — `calendarZoom`,
    // `historyGranularity`, `historyMode` — and not only the theme that
    // motivated it. The cache has already been written, so the device keeps a
    // value the server never received and it reverts at the next `init()`.
    // That is the deliberate trade: a bounded write that may still land must
    // not also be queued, or the replay lands on top of whatever the user
    // chose in the meantime, and these are all in-place toggles somebody is
    // actively working. `save` is the path for a value that must be confirmed.
    if (timedOut(err)) return;
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
 * @returns {Promise<{ok: boolean, value?: any, error?: string, offline?: boolean,
 *   indeterminate?: boolean}>} `indeterminate` means the write ran out of
 *   time: it may have landed, so it is neither a success nor a verdict.
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
      signal: bound(),
    });
  } catch (err) {
    // Out of time is NOT offline. See `timedOut`: the request may have landed,
    // so queueing it means replaying an unknown outcome over whatever came
    // next. The caller is told instead, and for the theme the durable device
    // record means the answer survives and is re-sent on the next reconcile.
    //
    // `indeterminate` is what lets the caller honour that. Without it a
    // black-holed write is one undiscriminated `{ok: false}` alongside a 429
    // and a refused value — so `toggleTheme` deleted the very record this
    // comment promises will survive, and reverted the theme ten seconds after
    // the press. A refusal is a VERDICT and this is the absence of one.
    if (timedOut(err)) {
      return { ok: false, indeterminate: true, error: 'the server did not answer' };
    }
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

  adopt(payload.settings, [key]);
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
 * @returns {Promise<{ok: boolean, ignored: string[], error?: string,
 *   offline?: boolean, indeterminate?: boolean}>} `indeterminate` as in
 *   `save`: out of time, and so no answer either way.
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
      signal: bound(),
    });
  } catch (err) {
    // Out of time is not offline — see `timedOut` above `save`.
    if (timedOut(err)) {
      return {
        ok: false, ignored: [], indeterminate: true,
        error: 'the server did not answer',
      };
    }
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

  adopt(payload.settings, keys);
  return { ok: true, ignored: payload.ignored ?? [] };
}

/**
 * Restore every setting to its default, on the server and locally.
 *
 * The server's answer is announced as a write of EVERY key, which it is: the
 * account now holds nothing, and a `stored` of `{}` with `full` is how that is
 * said. Without it this was the one write path that passed no meta at all, so
 * `ui/theme.js` never reconciled — Restore defaults reset everything except
 * the theme, whose device record then survived to be pushed back onto the
 * account it had just been cleared from.
 *
 * Only on a reply. Offline the defaults still apply here, but nothing has been
 * confirmed, and a record retired on a DELETE that never left the machine is
 * an answer thrown away for nothing.
 */
export async function reset() {
  cache = defaults();
  writeCache(cache);
  try {
    const res = await fetch('/api/settings',
      { method: 'DELETE', credentials: 'same-origin', signal: bound() });
    if (res.ok) {
      notifyAppliers(cache, { stored: {}, full: true, wrote: Object.keys(SETTINGS) });
    }
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
