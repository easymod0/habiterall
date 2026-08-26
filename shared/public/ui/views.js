/**
 * Which of the main views is showing.
 *
 * The dashboard and the detail view are mutually exclusive, so exactly one
 * piece of code should decide which is visible — otherwise both modules reach
 * for the other's container and the `hidden` flags drift apart. The auth
 * adapter needs the same power when a session expires, which is the third
 * reason this is not just a pair of local `querySelector` calls.
 *
 * The boot-error view is here for the same reason and one more: it is the only
 * thing that can be showing when nothing else can, so whatever raises it has to
 * be able to put the others away.
 */

const $ = (sel) => document.querySelector(sel);

const list = $('#view-list');
const detail = $('#view-detail');
const categories = $('#view-categories');
const error = $('#view-error');

const all = [list, detail, categories, error];

/** Hide every view, then show one. @returns the one shown */
function only(view) {
  for (const el of all) el.hidden = el !== view;
  return view;
}

/** Show the habit list. @returns its container */
export function showList() {
  return only(list);
}

/** Show the single-habit view. @returns its container */
export function showDetail() {
  return only(detail);
}

/** Show the category comparison. @returns its container, for the view to fill */
export function showCategories() {
  return only(categories);
}

/** Show the boot-error view. @returns its container, for the caller to fill */
export function showError() {
  return only(error);
}

/** Hide them all — for the signed-out state, where none has anything to say. */
export function hideAll() {
  for (const el of all) el.hidden = true;
}
