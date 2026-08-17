/**
 * "You have not answered these yet today" — the browser's own reminder.
 *
 * The web app is the primary UI and was the only surface that could not remind
 * you at all: Discord needs Discord and the `android` channel needs the phone.
 * It still cannot remind you at a TIME, and that is the platform rather than an
 * omission. A page's timers run only while a tab is open and are clamped to
 * roughly one a minute in the background; a service worker is terminated when
 * idle and has no wake-at-time event; Notification Triggers ran as an origin
 * trial and never shipped; Periodic Background Sync picks its own interval and
 * cannot hit a minute. Issue #70 has the whole survey, and its conclusion is
 * that a reminder at 08:30 needs the server — which is part 2 and is not this.
 *
 * So this is the honest half: when you ARRIVE — on boot and on
 * `visibilitychange` — anything whose reminder time has passed and whose day is
 * still unanswered says so. It needs no keys, no table and no server change, it
 * works offline because the answer is already in `state`, and the settings help
 * text says in one clause when it fires so that nobody plans a morning on it.
 *
 * **Dependency-free on purpose**, for the reason `ui/toggle.js` is: it is what
 * lets `test/nudge.test.js` run the rule AND the call site under Node, with no
 * browser and no module resolution — the absolute `/shared/...` specifiers the
 * rest of `public/ui` uses do not resolve there. Everything this needs from the
 * app arrives through `init()`: where the habits are and which days they can
 * speak for, which destinations are on, what day it is, and somewhere to say it
 * when the browser will not.
 *
 * It is NOT DOM-free, and the distinction is worth keeping straight: it owns no
 * markup and reaches for no element, but `init` does register one listener on
 * `document`, which is why `init` takes the document rather than only reading
 * the global. The other browser globals it touches (`Notification`,
 * `localStorage`) are read off `globalThis` and guarded, so the module loads
 * anywhere.
 */

/**
 * This destination's id, as `CHANNELS` in shared/src/notify.js spells it.
 *
 * Declared here rather than imported for the reason the whole module is
 * dependency-free, and pinned against the registry by `test/nudge.test.js` —
 * the same arrangement `ui/values.js` and `ui/toggle.js` already use.
 */
export const WEB_CHANNEL = 'web';

/**
 * `YES`, for the one predicate below that needs it.
 *
 * A fourth copy of a wire value, which is a thing this project is right to be
 * suspicious of — so `test/nudge.test.js` reads this line out of the source and
 * pins it against `ui/values.js`, exactly as `test/toggle.test.js` does for its
 * own. Only `YES` is here because only `YES` is used: an entry arrives as
 * `{value, status}` and a skip lives in the status column, so the SKIP sentinel
 * never has to be recognised in a value.
 */
const YES = 2;

/** 'HH:MM', the same shape `TIME_RE` in shared/src/constants.js accepts. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** How many habits a message names before it starts counting them. */
const MAX_NAMED = 4;

/** So a second nudge replaces the first rather than stacking under it. */
const TAG = 'habiterall-nudge';

/** The app's own icon, so the notification is recognisably this app's. */
const ICON = '/shared/icons/icon-192.png';

/* ---------- has this day been answered? ---------- */

/**
 * Has this habit's day been ANSWERED?
 *
 * The browser's mirror of `answeredIds` in shared/src/notify.js, which is what
 * decides whether a server-sent reminder still has a question to ask. It is a
 * mirror under the rule the root CLAUDE.md states — a client copies a rule only
 * if it must work OFFLINE — and this runs from `state` with no network, so it
 * cannot ask the server. `test/nudge.test.js` runs this and `answeredIds` over
 * the same fixtures, because a mirror with nothing pinning it to its original
 * is the thing this project keeps paying for.
 *
 * What it must NOT be is a third rule. "Does a row exist for today?" is the one
 * the phone had, and it silenced six-of-eight-glasses and a note-bearing "no"
 * while the server went on asking about the same day.
 *
 * Two clauses carry the whole of it.
 *
 * **A skip is an answer.** `isCompleted` returns `null` for one — "not
 * applicable" — which is falsy, so a truthiness test asks again about every day
 * the user has already dealt with. `!== false` is the distinction, and `false`
 * — a real miss, including a row holding 0 — still gets its nudge.
 *
 * **A day with no row is never answered, under either reading.** `answeredIds`
 * walks the rows that EXIST, so an unanswered day is not in it whatever
 * `atMostUnlogged` says — and this function is written so that fact cannot be
 * got wrong: a nullish entry returns `false` before anything else is asked, and
 * the account setting appears nowhere below. Read the other way round, an
 * at-most habit whose unlogged days count as staying under would report every
 * untouched day as answered, and this destination would go silent exactly where
 * Discord and the phone do not. The caller passes what the entries map HOLDS
 * (`Object.hasOwn`) and never `?? UNSET` — the collapse shared/CLAUDE.md
 * forbids of a reader.
 *
 * @param {{type?: string, target_type?: string, target_value?: number}} habit
 * @param {{value?: number, status?: string}|null|undefined} entry the row for
 *   that day, or nullish when there is none
 * @returns {boolean}
 */
export function isDayAnswered(habit, entry) {
  if (entry == null) return false;

  if (entry.status === 'skip') return true;

  const value = Number(entry.value) || 0;
  if (habit?.type === 'boolean') return value === YES;
  if (habit?.target_type === 'at_most') return value <= Number(habit.target_value);
  return value >= Number(habit.target_value);
}

/**
 * Could the payload in hand have held a row for this day AT ALL?
 *
 * The FIFTH state, and the one the four-state model has no square for: **not
 * fetched**. `/overview` answers a window — `dashboard.load()` sends
 * `end=state.gridEnd` — so paging the grid back a fortnight returns habits
 * whose `entries` legitimately stop before today. Read without this, a missing
 * key is "no row exists", which is the `?? UNSET` collapse arriving from the
 * other side: measured, ticking today and then pressing "Previous 14 days"
 * produced "1 habit still to answer today" about a habit answered an hour
 * earlier.
 *
 * The answer is to refuse rather than to guess, and silence is the only safe
 * direction — the alternative is nagging about a day the user has dealt with,
 * which is exactly what gets a destination switched off, and the dashboard
 * behind it is showing the truth either way. An unknown window refuses too:
 * before the first load there is nothing to judge.
 *
 * @param {{start?: string, end?: string}|null|undefined} loaded
 * @param {string} date
 */
function covers(loaded, date) {
  if (!loaded?.start || !loaded?.end) return false;
  return loaded.start <= date && date <= loaded.end;
}

/**
 * The row `/overview` reported for one habit on one date, or `undefined`.
 *
 * Only ever reached for a date `covers` has admitted, which is what lets
 * `undefined` here mean "no row" rather than "no idea".
 *
 * `entries` is a plain object of date to value with a skip flattened onto the
 * SKIP wire value, and `skips` lists the skipped dates separately — because a
 * measurable habit may legitimately record 3. So the status comes from `skips`
 * and never from the value, which is the same reading `dashboard.js` makes when
 * it paints the cell.
 *
 * `Object.hasOwn`, not `entries[date]`: the difference between a row holding 0
 * and no row at all is the whole of the four-state model, and a lookup that
 * cannot tell them apart is where it gets lost.
 */
function entryOn(habit, date) {
  if (habit?.skips?.includes(date)) return { value: 0, status: 'skip' };
  const entries = habit?.entries;
  if (!entries || !Object.hasOwn(entries, date)) return undefined;
  return { value: entries[date], status: '' };
}

/* ---------- what is outstanding right now ---------- */

/** Minutes since local midnight for an 'HH:MM', or null if it is not one. */
function minutesOfDay(hhmm) {
  const value = String(hhmm ?? '');
  if (!TIME_RE.test(value)) return null;
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Minutes since midnight on THIS DEVICE's clock.
 *
 * The browser's own, and never `notifyTimezone` or `resolveTimeZone`. Those
 * answer where an ACCOUNT is, so that a reminder nobody is present for still
 * goes out at the right hour; this is the question `callerDay` asks, with the
 * same answer — the grid draws its last column from this clock and never from a
 * setting, so a nudge judged against a NAMED zone would disagree with the row it
 * is about, for exactly the person who set one.
 *
 * Arithmetic on a Date's fields and nothing else. The calendar DAY is not
 * derived here: the app has one `iso()` and it lives in `ui/dates.js`, which is
 * the rule `test/dates.test.js` enforces over this whole directory — a
 * hand-built date string here would be the copy that file already deleted from
 * `charts.js` rather than exempted. It arrives through `init` instead.
 */
const minutesNow = (now) => now.getHours() * 60 + now.getMinutes();

/**
 * The habits this browser has something to say about.
 *
 * Pure: it is given the day and the minute rather than reading a clock, so the
 * whole rule can be exercised at any instant with no fake timers.
 *
 * Deliberately NOT bounded above the way `dueReminders`' `CATCH_UP_MINUTES` is.
 * That bound exists because a server-sent reminder is a wall-clock promise and
 * one delivered four hours late is worse than none — but this fires when you
 * open the app, so "your 08:00 habit is still outstanding" is exactly as true
 * at 19:00, and it is the only thing this destination can ever say. A catch-up
 * window here would mean opening the app at 08:31 and being told nothing.
 *
 * @param {any[]} habits as `/overview` returned them, entries and all
 * @param {{date: string, minutes: number, loaded?: {start: string, end: string}|null,
 *   already?: Set<number>|number[]}} clock
 *   `date` is the device's local day, `minutes` its local time, `loaded` the
 *   window those habits' entries actually came from, and `already` the habits
 *   this device has been told about on that day.
 * @returns {any[]} in the order they were given
 */
export function outstanding(habits, { date, minutes, loaded = null, already = [] }) {
  // Whole payload or nothing: if the window does not reach today then no
  // habit's entries can be read for it, so there is no per-habit answer to
  // give. See `covers`.
  if (!covers(loaded, date)) return [];

  const told = already instanceof Set ? already : new Set(already);

  return (habits ?? []).filter((habit) => {
    if (!habit || habit.archived) return false;
    if (told.has(habit.id)) return false;

    const at = minutesOfDay(habit.reminder_time);
    if (at === null) return false;              // '' — no reminder set
    if (minutes < at) return false;             // not yet, on this clock

    return !isDayAnswered(habit, entryOn(habit, date));
  });
}

/**
 * What to say about them.
 *
 * The wording is careful about what this is. "Still to answer" rather than
 * "reminder", because nothing was scheduled and nothing arrived at a time — the
 * app was opened and this is what it found. Calling it a reminder is how a
 * feature becomes a bug report six months later.
 *
 * @param {any[]} habits
 * @returns {{title: string, body: string}}
 */
export function nudgeMessage(habits) {
  const names = habits.map((h) => String(h?.name ?? 'Habit'));
  const shown = names.slice(0, MAX_NAMED);
  const rest = names.length - shown.length;

  return {
    title: names.length === 1
      ? '1 habit still to answer today'
      : `${names.length} habits still to answer today`,
    body: rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', '),
  };
}

/* ---------- the watermark ---------- */

/**
 * Which habits this device has already been nudged about, and when.
 *
 * The local counterpart of `notify_log`'s watermark, and it exists for the same
 * reason: without one, every `visibilitychange` re-notifies about the same
 * outstanding day, which is the surest way to have a destination switched off
 * for good.
 *
 * It is a DEVICE fact and not an account one, so it lives in localStorage and
 * is never written to the server. Two reasons and the second is the one worth
 * writing down. A notification was shown on THIS screen — the laptop that has
 * not been opened today has been told nothing, and an account-level watermark
 * would silence it. And settings are what `PUT /api/settings` writes and
 * `/api/export` carries, so a key there would end up in people's backups and in
 * both round-trip suites; that is the same argument that keeps `notify_status`
 * out of the settings blob. This is a record of what happened, not a
 * preference.
 *
 * Keyed on the habit and the LOCAL date, and the date is stored WITH the ids
 * rather than in the key: a new day replaces the whole record, so nothing here
 * grows without bound and there is no sweep to remember to write.
 */
const STORE_KEY = 'habiterall-nudged';

/** localStorage, or nothing — private browsing and Node both have none. */
function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;                 // a security policy can throw on the getter
  }
}

/** @returns {Set<number>} habit ids already nudged about on `date` */
export function alreadyNudged(date) {
  try {
    const raw = storage()?.getItem(STORE_KEY);
    const held = raw ? JSON.parse(raw) : null;
    if (!held || held.date !== date) return new Set();
    return new Set(Array.isArray(held.ids) ? held.ids : []);
  } catch {
    return new Set();            // corrupt: nudge once more rather than throw
  }
}

/** Record that these ids have now been nudged about on `date`. */
export function markNudged(date, ids) {
  try {
    storage()?.setItem(STORE_KEY, JSON.stringify({ date, ids: [...ids] }));
  } catch {
    // No quota, or no storage at all. The nudge has already been shown; the
    // cost of failing here is being told twice, which is better than not at
    // all — so this is not reported anywhere.
  }
}

/* ---------- saying it ---------- */

/**
 * Whether this browser will raise a notification, in the four states that
 * matter to the settings dialog.
 *
 * @returns {'unsupported'|'default'|'granted'|'denied'}
 */
export function permissionState() {
  const api = globalThis.Notification;
  if (!api || typeof api.permission !== 'string') return 'unsupported';
  return /** @type {any} */ (api.permission);
}

/**
 * Raise it — as a notification if this browser has allowed one, and inside the
 * app if it has not.
 *
 * Two ways to raise one, and both are needed. On Android Chrome the
 * `Notification` constructor **throws**, and only
 * `registration.showNotification` works; the constructor is what a desktop
 * browser with no service worker has (a fresh profile, or a suite that has just
 * unregistered them). So the worker is tried first and the constructor is the
 * fallback.
 *
 * `getRegistration()` and never `ready`: that promise does not settle until a
 * worker is active, so on a page with none it would hang forever — and it would
 * hang holding the fallback, which is the one path that has to work.
 *
 * The in-app fallback is not a consolation prize. It is what this destination
 * does for everyone who has said no or never been asked, it is what issue #70
 * asks for by name, and it is the only surface on a browser that has no
 * Notification API at all.
 *
 * @param {{title: string, body: string}} message
 * @param {(text: string) => void} fallback
 * @returns {Promise<'notification'|'app'>} which surface said it
 */
export async function announce(message, fallback) {
  if (permissionState() === 'granted') {
    const options = { body: message.body, tag: TAG, icon: ICON };

    try {
      const registration = await globalThis.navigator?.serviceWorker?.getRegistration?.();
      if (registration?.active && registration.showNotification) {
        await registration.showNotification(message.title, options);
        return 'notification';
      }
    } catch {
      // A worker that will not show one is not a reason to say nothing.
    }

    try {
      new globalThis.Notification(message.title, options);
      return 'notification';
    } catch {
      // Android Chrome, where the constructor is illegal. Fall through.
    }
  }

  fallback(`${message.title}: ${message.body}`);
  return 'app';
}

/* ---------- the trigger ---------- */

/**
 * What `init` was given. Null until then, so `check()` from anywhere else is a
 * no-op rather than a throw.
 *
 * @type {{habits: () => any[], enabled: () => string[], today: () => string,
 *         loaded: () => {start: string, end: string}|null,
 *         fallback: (text: string) => void}|null}
 */
let wiring = null;

/**
 * Look, and say something if there is anything to say.
 *
 * It reads whatever the app has ALREADY fetched and never fetches itself, which
 * is what makes it work offline and is also its one blind spot: answer a day on
 * the phone and switch to a browser tab that has been open since the morning,
 * and the answer is not in `state.habits` yet, so this can nudge about a day
 * that has been dealt with. The watermark caps that at one per habit per day,
 * the dashboard behind it shows the truth, and the alternative — a fetch on
 * every `visibilitychange` — is traffic on a schedule the user did not ask for.
 * `covers` is the same problem in its one form that can be answered locally.
 *
 * The watermark is written BEFORE the announcement rather than after it: a
 * `showNotification` that rejects has still, on some browsers, shown one, and
 * being told twice about the same day is the failure this whole record exists
 * to prevent. Nothing is lost by the other ordering being wrong — the habit is
 * still outstanding, and the dashboard behind this is showing it.
 *
 * Never throws: it is wired to an event handler and to the tail of boot, and a
 * nudge that fails must not take either down with it.
 *
 * @param {{now?: Date}} [opts]
 * @returns {Promise<any[]>} the habits it spoke about, for tests and callers
 */
export async function check({ now = new Date() } = {}) {
  if (!wiring) return [];

  try {
    if (!(wiring.enabled() ?? []).includes(WEB_CHANNEL)) return [];

    const date = wiring.today();
    const already = alreadyNudged(date);
    const due = outstanding(wiring.habits() ?? [], {
      date,
      minutes: minutesNow(now),
      loaded: wiring.loaded?.() ?? null,
      already,
    });
    if (!due.length) return [];

    markNudged(date, [...already, ...due.map((h) => h.id)]);
    await announce(nudgeMessage(due), wiring.fallback);
    return due;
  } catch {
    return [];
  }
}

/**
 * Wire it to the app.
 *
 * Injected rather than imported, which is what keeps this module loadable under
 * Node — see the note at the top. All five things it needs belong to somebody
 * else: `state.habits` and `state.gridLoaded` are the dashboard's,
 * `notifyChannels` is the settings registry's, the toast is `ui/toast.js`'s,
 * and `todayISO` is `ui/dates.js`'s — that last one because this app has
 * exactly one `iso()` and building a second here is what `test/dates.test.js`
 * refuses.
 *
 * `loaded` travels WITH `habits` because they are one answer: which habits, and
 * which days their entries are able to speak for. Taking the first without the
 * second is the defect `covers` is written about.
 *
 * `visibilitychange` is the second trigger and the reason the watermark exists.
 * It is a separate listener from `ui/connectivity.js`'s, deliberately: that one
 * drains the outbox, this one reads state, and folding two unrelated concerns
 * into one handler is how the next change to either breaks the other.
 *
 * @param {{habits: () => any[], enabled: () => string[], today: () => string,
 *          loaded?: () => {start: string, end: string}|null,
 *          fallback: (text: string) => void,
 *          doc?: {addEventListener: Function, visibilityState?: string}}} deps
 */
export function init({
  habits, enabled, today, loaded, fallback, doc = globalThis.document,
}) {
  wiring = { habits, enabled, today, loaded, fallback };

  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') return;
    // `check` swallows its own failures; this is belt and braces for the
    // promise itself, since an unhandled rejection in a listener is noisy and
    // reaches the user as nothing at all.
    check().catch(() => {});
  });
}
