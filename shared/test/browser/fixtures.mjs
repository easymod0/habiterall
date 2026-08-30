/**
 * Deterministic fixtures for the browser suites.
 *
 * These tests drive a real server, so they need known data. Previously each
 * suite assumed whatever happened to be in the database, which made them pass
 * or fail depending on what had run before — the worst kind of flakiness,
 * because a genuine regression is indistinguishable from leftover state.
 *
 * `reset()` returns the instance to a known shape via the public API, so it
 * works identically against the single-user and multi-user editions.
 */

let BASE = process.env.BASE ?? 'http://localhost:3000';

/**
 * Point the fixtures at a specific instance, for a suite run standalone.
 *
 * **The runner does NOT use this** — it passes `base` to `reset` directly.
 * Module-level state cannot be shared by parallel workers: `reset` awaits ~240
 * times and `api` reads this binding at each call, so a second worker's
 * `useBase` lands in the middle of the first one's reset and the rest of it
 * deletes the wrong instance's habits. That is exactly the failure this file's
 * runner documents at length, arrived at from the other direction.
 */
export function useBase(url) { BASE = url; }

/** Covers every habit shape the UI renders differently. */
export const FIXTURE_HABITS = [
  {
    name: 'Meditate', type: 'boolean', color: '#8b5cf6',
    freq_numerator: 1, freq_denominator: 1,
  },
  {
    name: 'Gym', type: 'boolean', color: '#f59e0b',
    freq_numerator: 3, freq_denominator: 7,
  },
  {
    name: 'Read', type: 'numerical', unit: 'pages', target_value: 20,
    target_type: 'at_least', color: '#0ea5e9',
    freq_numerator: 1, freq_denominator: 1,
  },
  {
    // An at-most habit with target 0: the case where a recorded 0 is a
    // success and must render as a full-strength cell, not an empty one.
    name: 'No late-night snacks', type: 'numerical', unit: 'snacks',
    target_value: 0, target_type: 'at_most', color: '#10b981',
    freq_numerator: 1, freq_denominator: 1,
  },
];

const api = async (path, options = {}, base = BASE) => {
  const res = await fetch(`${base}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
};

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const daysAgo = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return iso(d);
};

/**
 * Wipe and recreate the fixture set, with ~60 days of history so the charts
 * and streak views have something real to render.
 *
 * `base` is read ONCE, here, and threaded through every request below — never
 * re-read from module state, which parallel workers share. See `useBase`.
 *
 * @param {{days?: number, base?: string}} [opts]
 * @returns {Promise<object[]>} the created habits, in fixture order
 */
export async function reset({ days = 60, base = BASE } = {}) {
  const at = (path, options) => api(path, options, base);

  // Preferences are server-side now, so a suite that changed one would leak
  // into every suite after it — the dashboard would render in the wrong day
  // order and alignment assertions would fail for no visible reason.
  await at('/settings', { method: 'DELETE' }).catch(() => {});

  // Categories are their own table and outlive a habit delete on purpose
  // (ON DELETE SET NULL, never CASCADE) — so without this they otherwise
  // accumulate across every suite that runs against one instance, the same
  // leftover-state problem this function exists to prevent for habits.
  for (const c of await at('/categories')) {
    await at(`/categories/${c.id}`, { method: 'DELETE' });
  }

  for (const q of ['', '?archived=true']) {
    for (const h of await at(`/habits${q}`)) {
      await at(`/habits/${h.id}`, { method: 'DELETE' });
    }
  }

  const created = [];
  for (const spec of FIXTURE_HABITS) {
    created.push(await at('/habits', { method: 'POST', body: JSON.stringify(spec) }));
  }

  const [meditate, gym, read, snacks] = created;

  for (let i = days - 1; i >= 0; i--) {
    const date = daysAgo(i);
    const dow = new Date(`${date}T12:00:00`).getDay();

    // Deterministic, not random: a failing suite must be reproducible.
    if (i % 9 !== 0) {
      await at(`/habits/${meditate.id}/entries/${date}`,
        { method: 'PUT', body: JSON.stringify({ value: 2 }) });
    }
    if ([1, 3, 5].includes(dow)) {
      await at(`/habits/${gym.id}/entries/${date}`,
        { method: 'PUT', body: JSON.stringify({ value: 2 }) });
    }
    await at(`/habits/${read.id}/entries/${date}`,
      { method: 'PUT', body: JSON.stringify({ value: 10 + (i % 21) }) });
    // 0, 1 and 2 snacks all appear, so shading differences are visible.
    await at(`/habits/${snacks.id}/entries/${date}`,
      { method: 'PUT', body: JSON.stringify({ value: i % 4 === 0 ? i % 3 : 0 }) });
  }

  return created;
}

/** Named lookup, so suites need no positional assumptions. */
export async function habitsByName() {
  const list = await api('/habits');
  return Object.fromEntries(list.map((h) => [h.name, h]));
}

/**
 * The two habits `seedCategorySpread` creates, named so a suite can find them
 * and so a standalone re-run can clear its own leftovers.
 */
export const SPREAD_UNLOGGED_HABIT = 'Learn kana';
export const SPREAD_ARCHIVED_HABIT = 'Old morning routine';

/**
 * Categories carrying every shape the comparison view (`#/categories`) draws
 * differently, laid over the fixture habits `reset()` has just created.
 *
 * **Not part of `reset()`, deliberately** — the same reasoning
 * `responsive.mjs` writes down above its own `seedForSearch`: that function is
 * the input to every browser suite and several of them count rows or index
 * them positionally, so two more habits and a top-bar button that appears only
 * for an account WITH a category would change what a dozen other suites are
 * looking at, to serve three. Call this from the suite that needs it, after
 * the runner's reset.
 *
 * The spread is the point, and every member of it is a case the view has its
 * own branch for:
 *
 *   'Body & mind'   two logged members, so `best` and `worst` name different
 *                   habits — plus the ARCHIVED one, which is counted into
 *                   `archivedExcluded` and into no figure
 *   'Reading'       one member, and DAILY: `best === worst`, and its mean is
 *                   that one habit's own strength, so the card and the habit's
 *                   own page can be held against each other. Daily because
 *                   `onPaceSeries` pro-rates a non-daily habit's requirement
 *                   over its first `denominator - 1` days, which two windows
 *                   starting on different days legitimately disagree about
 *   'Dormant'       no members at all: `mean` is null and the card says so
 *   'Just started'  one member that has NEVER been logged: `mean` is null for
 *                   the other reason, and `unloggedExcluded` is 1
 *   Uncategorised   'No late-night snacks' is left alone, so the trailing
 *                   section has something in it
 *
 * Nothing here holds a default. The colours are none of the four the fixture
 * habits use, both new habits are non-daily and non-boolean-by-default shapes,
 * and the archived member's frequency (2/7) is neither of the two `reset()`
 * already creates — a fixture equal to the value it is compared against is
 * this repo's most-shipped test defect.
 *
 * @param {{base?: string, days?: number}} [opts]
 * @returns {Promise<{wellbeing: object, reading: object, dormant: object,
 *                    fresh: object, unlogged: object, archived: object}>}
 */
export async function seedCategorySpread({ base = BASE, days = 60 } = {}) {
  const at = (path, options) => api(path, options, base);

  // Categories outlive a habit delete (`ON DELETE SET NULL`), and `reset()`
  // only runs before a suite launched through `run.mjs` — so a standalone
  // re-run would otherwise stack this spread on top of the last one's.
  for (const c of await at('/categories')) {
    await at(`/categories/${c.id}`, { method: 'DELETE' });
  }
  for (const query of ['', '?archived=true']) {
    for (const h of await at(`/habits${query}`)) {
      if (h.name === SPREAD_UNLOGGED_HABIT || h.name === SPREAD_ARCHIVED_HABIT) {
        await at(`/habits/${h.id}`, { method: 'DELETE' });
      }
    }
  }

  const category = (name, color) =>
    at('/categories', { method: 'POST', body: JSON.stringify({ name, color }) });

  const wellbeing = await category('Body & mind', '#a855f7');
  const reading = await category('Reading', '#0891b2');
  const dormant = await category('Dormant', '#e11d48');
  const fresh = await category('Just started', '#65a30d');

  // `PUT /habits/:id` REPLACES, so an edit carries the whole fetched row back
  // with the one field changed — a bare `{category_id}` would clear every
  // other field to its default. See `shared/CLAUDE.md`.
  const byName = await (async () => {
    const list = await at('/habits');
    return Object.fromEntries(list.map((h) => [h.name, h]));
  })();
  const put = (habit, patch) => at(`/habits/${habit.id}`,
    { method: 'PUT', body: JSON.stringify({ ...habit, ...patch }) });

  await put(byName.Meditate, { category_id: wellbeing.id });
  await put(byName.Gym, { category_id: wellbeing.id });
  await put(byName.Read, { category_id: reading.id });
  // 'No late-night snacks' is left uncategorised on purpose.

  const unlogged = await at('/habits', {
    method: 'POST',
    body: JSON.stringify({
      name: SPREAD_UNLOGGED_HABIT, type: 'numerical', unit: 'cards',
      target_value: 15, target_type: 'at_least', color: '#f43f5e',
      freq_numerator: 5, freq_denominator: 7, category_id: fresh.id,
    }),
  });

  const archived = await at('/habits', {
    method: 'POST',
    body: JSON.stringify({
      name: SPREAD_ARCHIVED_HABIT, type: 'boolean', color: '#7c3aed',
      freq_numerator: 2, freq_denominator: 7, category_id: wellbeing.id,
    }),
  });
  // Logged, and logged WELL: an archived member left empty would be excluded
  // by the never-logged rule too, and the check that it is excluded for being
  // archived would pass against a route that had never heard of `archived`.
  for (let i = days - 1; i >= 0; i -= 3) {
    await at(`/habits/${archived.id}/entries/${daysAgo(i)}`,
      { method: 'PUT', body: JSON.stringify({ value: 2 }) });
  }
  await put(archived, { archived: true });

  return { wellbeing, reading, dormant, fresh, unlogged, archived };
}
