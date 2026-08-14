/**
 * Light/dark theme, persisted in localStorage and defaulting to the system
 * preference.
 *
 * Switching it repaints everything by itself, and this module does not tell
 * anybody it happened. That is new: the charts used to resolve their colours
 * to literals at draw time, so a switch had to be followed by a redraw — and
 * in the detail view a redraw is a REFETCH, which made the palette on screen
 * depend on two network requests. They now emit `var(--…)` and `color-mix()`,
 * which the cascade resolves live, so there is nothing left to tell anyone
 * about. See `themed` in charts.js.
 */

const STORAGE_KEY = 'habiterall-theme';

/** Apply the saved theme, or follow the system preference. */
export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved ?? (prefersDark ? 'dark' : 'light');
}

/** Flip between light and dark and remember the choice. */
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(STORAGE_KEY, next);
}
