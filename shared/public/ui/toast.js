/**
 * The transient message strip at the bottom of the page.
 *
 * Owns `#toast` and nothing else, so every other module can report a failure
 * without pulling in a view.
 */

const $ = (sel) => document.querySelector(sel);

const el = $('#toast');

let timer;

/**
 * Show a transient message. Pass `actionLabel`/`onAction` for an inline
 * button (e.g. Undo), which gets a longer timeout so it can be read and hit.
 *
 * @param {string} message
 * @param {{actionLabel?: string|null, onAction?: (() => void)|null}} [opts]
 */
export function toast(message, { actionLabel = null, onAction = null } = {}) {
  el.replaceChildren();

  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);

  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      clearTimeout(timer);
      el.hidden = true;
      onAction();
    });
    el.append(btn);
  }

  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { el.hidden = true; }, actionLabel ? 9000 : 2600);
}
