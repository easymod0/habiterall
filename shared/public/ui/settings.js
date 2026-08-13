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
 * @property {'select'|'toggle'} type
 * @property {any} default
 * @property {{value: string, label: string}[]} [options]  for `select`
 * @property {string} [section]  groups controls in the dialog
 */

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
function defaults() {
  return Object.fromEntries(
    Object.entries(SETTINGS).map(([k, def]) => [k, def.default])
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
  if (def.type === 'toggle') return typeof value === 'boolean';
  if (def.type === 'select') return def.options.some((o) => o.value === value);
  return false;
}

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

/**
 * Persist one setting.
 *
 * Applies locally first so the UI responds immediately, then writes through
 * to the server. A failed write leaves the value cached for this device and
 * is retried on the next `init()`.
 *
 * @returns {boolean} whether the value was accepted
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
  }).catch(async () => {
    // Offline. Queue the write so the choice reaches the server rather than
    // living on this device only — otherwise a preference set on a train
    // silently fails to follow the account.
    try {
      const { enqueue } = await import('/shared/offline.js');
      await enqueue({ url: '/api/settings', method: 'PUT', body });
    } catch {
      // No outbox available; the cached value still applies here.
    }
  });

  return true;
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
