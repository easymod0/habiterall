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

/** Point the fixtures at a specific instance (the runner does this). */
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

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
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
 * @returns {Promise<object[]>} the created habits, in fixture order
 */
export async function reset({ days = 60 } = {}) {
  // Preferences are server-side now, so a suite that changed one would leak
  // into every suite after it — the dashboard would render in the wrong day
  // order and alignment assertions would fail for no visible reason.
  await api('/settings', { method: 'DELETE' }).catch(() => {});

  for (const q of ['', '?archived=true']) {
    for (const h of await api(`/habits${q}`)) {
      await api(`/habits/${h.id}`, { method: 'DELETE' });
    }
  }

  const created = [];
  for (const spec of FIXTURE_HABITS) {
    created.push(await api('/habits', { method: 'POST', body: JSON.stringify(spec) }));
  }

  const [meditate, gym, read, snacks] = created;

  for (let i = days - 1; i >= 0; i--) {
    const date = daysAgo(i);
    const dow = new Date(`${date}T12:00:00`).getDay();

    // Deterministic, not random: a failing suite must be reproducible.
    if (i % 9 !== 0) {
      await api(`/habits/${meditate.id}/entries/${date}`,
        { method: 'PUT', body: JSON.stringify({ value: 2 }) });
    }
    if ([1, 3, 5].includes(dow)) {
      await api(`/habits/${gym.id}/entries/${date}`,
        { method: 'PUT', body: JSON.stringify({ value: 2 }) });
    }
    await api(`/habits/${read.id}/entries/${date}`,
      { method: 'PUT', body: JSON.stringify({ value: 10 + (i % 21) }) });
    // 0, 1 and 2 snacks all appear, so shading differences are visible.
    await api(`/habits/${snacks.id}/entries/${date}`,
      { method: 'PUT', body: JSON.stringify({ value: i % 4 === 0 ? i % 3 : 0 }) });
  }

  return created;
}

/** Named lookup, so suites need no positional assumptions. */
export async function habitsByName() {
  const list = await api('/habits');
  return Object.fromEntries(list.map((h) => [h.name, h]));
}
