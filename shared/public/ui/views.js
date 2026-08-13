/**
 * Which of the two main views is showing.
 *
 * The dashboard and the detail view are mutually exclusive, so exactly one
 * piece of code should decide which is visible — otherwise both modules reach
 * for the other's container and the `hidden` flags drift apart. The auth
 * adapter needs the same power when a session expires, which is the third
 * reason this is not just a pair of local `querySelector` calls.
 */

const $ = (sel) => document.querySelector(sel);

const list = $('#view-list');
const detail = $('#view-detail');

/** Show the habit list. @returns its container */
export function showList() {
  detail.hidden = true;
  list.hidden = false;
  return list;
}

/** Show the single-habit view. @returns its container */
export function showDetail() {
  list.hidden = true;
  detail.hidden = false;
  return detail;
}

/** Hide both — for the signed-out state, where neither has anything to say. */
export function hideAll() {
  list.hidden = true;
  detail.hidden = true;
}
