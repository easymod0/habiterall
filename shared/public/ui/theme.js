/**
 * Light/dark theme, persisted in localStorage and defaulting to the system
 * preference.
 *
 * The charts read their colours from CSS custom properties at draw time, so
 * whatever is on screen has to be redrawn after a switch. Rather than reach
 * back into the app's state, the caller supplies that as a callback — which
 * is what lets this be a standalone module.
 */

const STORAGE_KEY = 'habiterall-theme';

/** Apply the saved theme, or follow the system preference. */
export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved ?? (prefersDark ? 'dark' : 'light');
}

/**
 * Flip between light and dark and remember the choice.
 * @param {() => void} [onChange] called after the switch, to redraw charts
 */
export function toggleTheme(onChange) {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(STORAGE_KEY, next);
  onChange?.();
}
