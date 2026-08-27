/**
 * Create, edit, delete and undelete a habit.
 *
 * Owns `#habit-dialog` and its form, plus the "New habit" button that opens
 * it. Announces `'reload'` when it changes something, so it never has to know
 * which view is showing.
 */

import { api } from '/shared/ui/api.js';
import { focusKeyOf } from '/shared/ui/components.js';
import { reminderField } from '/shared/ui/reminder-field.js';
import * as settings from '/shared/ui/settings.js';
import { dashboardShowing, emit, staysOnList, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';

const $ = (sel) => document.querySelector(sel);

const dialog = $('#habit-dialog');
const form = $('#habit-form');
const title = $('#dialog-title');
const del = $('#dialog-delete');
const archivedWrap = $('#archived-wrap');

/**
 * Six starting points, not seeded rows — an account with no habits gets no
 * empty sections (see "Do not seed default categories", docs/decisions/
 * categories.md). Each carries its own default colour so a dashboard grouped
 * by category has distinguishable headers from the first tap rather than six
 * landing on the habit dialog's own default blue.
 */
const CATEGORY_SUGGESTIONS = [
  { name: 'Health', color: '#10b981' },
  { name: 'Work', color: '#3b82f6' },
  { name: 'Fitness', color: '#f59e0b' },
  { name: 'Mind', color: '#8b5cf6' },
  { name: 'Social', color: '#ec4899' },
  { name: 'Home', color: '#0ea5e9' },
];

/** Which category's manage row is showing its rename/recolour controls. */
let editingCategoryId = null;

/**
 * Which category read is the CURRENT one — `state.categoryReadSeq`, bumped by
 * every `refreshCategoryPicker` and by `moveCategory`'s optimistic splice.
 *
 * `state.categories` has more than one writer that can be in flight at once,
 * and until this existed the LAST answer to arrive won regardless of which
 * one was freshest. Three of those writers exist. Two ship in this file:
 * `openDialog`'s fire-and-forget refetch, which by its own docstring can land
 * at any point after the dialog opened, and `moveCategory`'s per-press one —
 * and the arrows are deliberately not disabled while a write is in flight, so
 * two presses overlapping is the ordinary gesture for moving a category more
 * than one slot rather than an edge case. A GET answered before a later
 * press's POST committed, but delivered after that press's own GET, then
 * installed an order the server had already moved past; the next press
 * computed its payload from that stale list and wrote the regression back, so
 * the SERVER's order ended up wrong too and not merely the display.
 *
 * The THIRD is `load()` in `dashboard.js`, which is why the counter itself
 * lives in `store.js` rather than here: `announce()` sends every other
 * category mutation in this file through `'reload'`, and `/overview`'s answer
 * carries the whole category list too. Add a category and press ↑ on it —
 * which is the ordinary gesture, since a create lands at `MAX(position) + 1`
 * and so puts the new row at the BOTTOM — and that `/overview`, issued before
 * the move existed, lands after it. It is a read like any other and now takes
 * a ticket like any other.
 *
 * A monotonic counter is what `persistOrder` (dashboard.js) does not need and
 * this does: that one never refetches after its own write, so it cannot race
 * a second call's READ. The per-press GET is a mechanism the habit list has
 * no counterpart for, which is why the PR that added it could not inherit an
 * answer here.
 */

/**
 * Tell whatever is behind this modal that something it draws has moved.
 *
 * **A dialog does not know which view it was opened over, and it must not
 * navigate away from one.** `'reload'` means "go to the dashboard and fetch
 * it", which is right when the dashboard is already what is showing — a
 * repaint alone would draw the old list without the habit that was just made —
 * and is a navigation the user did not ask for from anywhere else. `'change'`
 * means "the visible view's data moved", which every other view answers by
 * refetching itself in place.
 *
 * Five call sites: `saveHabit`, and the four category mutations this dialog
 * makes in place (rename, delete, a suggestion chip, the New category box).
 * The last four used to emit `'reload'` unconditionally, which is how **adding
 * a category while editing a habit dropped the user back on the dashboard** —
 * `#btn-new` and this dialog's category manager are reachable from a habit's
 * own page and from `#/categories`, and neither is the list.
 *
 * The three that stay unconditional are the ones where going home is the
 * answer: a habit deleted, a habit restored, and a create whose request was
 * abandoned. The page you were on is gone, or nobody knows what it holds.
 *
 * `moveCategory` is a fifth category mutation, and it deliberately does NOT
 * call this function at all — see its own `emit('change')` and the comment
 * there. A reorder changes no figure `announce()`'s `'reload'` exists to
 * fetch, and `/overview` is a second writer of `state.categories` that can
 * land after this list has already moved again.
 */
const announce = () => emit(dashboardShowing() ? 'reload' : 'change');

function categoryHint(message, isError = false) {
  const hint = $('#category-hint');
  hint.textContent = message;
  hint.classList.toggle('error', isError);
}

/**
 * Make Enter in INPUT press BUTTON, instead of submitting the habit form.
 *
 * Both of this dialog's category text boxes — the "New category" name and a
 * manage row's rename box — live INSIDE `#habit-form`, because the picker
 * manages the account's categories in place rather than on a screen of its
 * own. That form has a `type="submit"` Save button, so Enter in either box is
 * an implicit submission: the dialog closed, the HABIT was written, and the
 * category that had just been typed was never created — a rename never sent.
 * On the create path it also wrote a half-configured habit out of the form's
 * defaults. Nothing said so, because `saveHabit` succeeds on its own terms and
 * `#category-hint` is only ever written by the category handlers, so the one
 * surface that could have reported it stayed blank.
 *
 * Enter after typing a name is the gesture, not an edge case, which is why
 * this routes the key rather than merely calling `preventDefault` — a box
 * where Enter does nothing is its own bug report. The button is the same one
 * a click goes through, so there is one handler per action and no second copy
 * of what Add or Save means.
 *
 * `isComposing` is excluded: mid-composition an IME uses Enter to COMMIT the
 * candidate, and stealing it there would submit a half-typed name in the
 * scripts that need one most.
 *
 * @param {HTMLInputElement} input
 * @param {HTMLButtonElement} button
 */
function enterPresses(input, button) {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    button.click();
  });
}

/** The form's own selection, as a number or null — never `''`. */
function currentCategoryId() {
  return form.category_id.value ? Number(form.category_id.value) : null;
}

/**
 * Rebuild the `<select>` from `state.categories`, keeping WANTED selected if
 * it still exists — a delete elsewhere in the account can remove the very
 * category this form had chosen.
 *
 * A non-null WANTED may never fall back to `''` (none) for want of a list
 * that simply has not landed. `state.categories` starts `[]` and stays that
 * way until `dashboard.load()` or `refreshCategoryPicker` populates it — and
 * a cold deep link to a habit's own page (`#/habit/42`, opened straight from
 * a reminder, an Android tap, or a reload) runs NEITHER before this dialog
 * opens: `app.js`'s boot skips `dashboard.load()` entirely on that path. This
 * function used to build the `<select>` from that empty list and then fall
 * `select.value` to `''` because the wanted id matched nothing in it — so
 * pressing Save with nothing changed sent `category_id: null`, and
 * `PUT /habits/:id` REPLACES: the habit's category was gone, silently, with
 * nothing on screen to say so. This is the half that has to hold OFFLINE,
 * where the fetch behind `refreshCategoryPicker` cannot land at all — it is
 * not belt-and-braces alongside that refetch, it is what saves a device that
 * never gets an answer.
 *
 * The placeholder below is for a real, EXPLICIT id only — `wanted` itself,
 * never the `select.value` fallback. `wanted === null` is its own answer
 * ("this form has no category, stated": `openDialog` passes it for every
 * uncategorised habit and every create) and must still be free to land on
 * "(none)"; only `wanted === undefined` falls back to whatever the control
 * already showed.
 *
 * **`openDialog`'s own synchronous first render is the ONLY caller that names
 * a `wanted` at all, and that is a rule rather than a coincidence.** It is the
 * one place an id is known to belong to the dialog being drawn, because
 * nothing is awaited between deciding it and drawing it. Every other path
 * here goes through `refreshCategoryPicker`, which takes no argument for
 * exactly this reason — read its comment before adding one back. Its
 * fire-and-forget call at the end of `openDialog` is the case that makes the
 * distinction matter: that continuation can land long after the dialog it
 * started from has closed, been reused for a different habit, or had its own
 * control hand-changed, and none of that is visible to a value captured when
 * the fetch was fired — reading `select.value` at render time instead means
 * the late answer can only ever re-confirm whichever habit's dialog is
 * actually open, never overwrite it with a stale one.
 *
 * That distinction is written `!== undefined`, and it MUST NOT be written
 * `!= null`, which is the same expression for both and is how this shipped
 * once: `openDialog` calls this as `habit?.category_id ?? null`, so every
 * uncategorised habit arrived as `null` and took the fall-back branch. The
 * `<select>` is one persistent element and nothing resets it between opens —
 * `<dialog>.close()` does not reset a form and there is no `form.reset()`
 * here — so the value it fell back to was the PREVIOUS dialog's. Edit a
 * habit in Health, cancel, open an uncategorised one and its picker read
 * "Health"; Save with nothing else changed and `PUT /habits/:id` REPLACES,
 * so the habit was committed into a category nobody had chosen for it. Same
 * for "New habit" straight after editing a categorised one. It needed no
 * race and no slow network, unlike the two failures the paragraphs above
 * describe — which is why `categorycheck` walking both of those still saw
 * nothing: every habit in those blocks carries a category, so `wanted` was a
 * number, and the create block is preceded by a `Page.navigate` that throws
 * the stale value away.
 *
 * @param {number | null} [wanted]
 */
function renderCategorySelect(wanted) {
  const select = form.category_id;
  // A real id the caller named, as opposed to a stated `null` or the absent
  // argument — the one case that may keep the control's own current value.
  const pinned = wanted !== undefined && wanted !== null;
  const want = pinned ? String(wanted) : (wanted === undefined ? select.value : '');
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(none)';
  select.append(none);
  for (const c of state.categories) {
    const opt = document.createElement('option');
    opt.value = String(c.id);
    opt.textContent = c.name;
    select.append(opt);
  }
  const known = state.categories.some((c) => String(c.id) === want);
  // Resolvable names come from the loop above; this only ever fires for an id
  // that loop could not find, so there is nothing here to label it with but a
  // neutral placeholder — a real name arrives, if it exists, the moment
  // `state.categories` does and this function runs again.
  if (pinned && !known) {
    const placeholder = document.createElement('option');
    placeholder.value = want;
    placeholder.textContent = '(current category)';
    select.append(placeholder);
  }
  select.value = (known || pinned) ? want : '';
}

/** The manage list: one row per category, ↑/↓ to reorder, ✎ for rename+recolour, ✕ to delete. */
function renderCategoryManage() {
  const list = $('#category-manage');
  list.replaceChildren();

  // Same gate `reorderable` uses for the dashboard's own drag handle
  // (dashboard.js:307) — moving a row only means something once there is a
  // second row to move it past.
  const canReorder = state.categories.length > 1;

  state.categories.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'category-manage-row';
    li.dataset.categoryId = String(c.id);

    if (editingCategoryId === c.id) {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'category-edit-name';
      nameInput.maxLength = 100;
      nameInput.value = c.name;
      nameInput.setAttribute('aria-label', `Rename ${c.name}`);

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'category-edit-color';
      colorInput.value = c.color;
      colorInput.setAttribute('aria-label', `Colour for ${c.name}`);

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-sm';
      save.textContent = 'Save';
      save.addEventListener('click', async () => {
        try {
          await api(`/categories/${c.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: nameInput.value, color: colorInput.value }),
          });
          editingCategoryId = null;
          // No argument — see `refreshCategoryPicker`. A rename changes a
          // category's NAME, never which one this form has chosen, so there
          // is nothing to force here and forcing it is what goes wrong.
          await refreshCategoryPicker();
          announce();
        } catch (err) {
          // A queued write is the outbox doing its job, not a failure — the
          // same reading the two add handlers below already give it. `PUT
          // /categories/:id` is `replayable()` (ui/api.js: everything but
          // `POST /habits`), so offline this throws "Saved offline — will
          // sync when you reconnect", and showing that in the error class
          // made the one path that IS working look like the broken one.
          //
          // Saying so is not enough on its own, because `editingCategoryId`
          // is cleared on the line after the `await` and so not at all here:
          // the row stayed in edit mode, beside a Cancel button that only
          // resets local state. The write is already staged in the outbox by
          // then and nothing dequeues on a click, so that Cancel offered an
          // undo that does not exist — press it and the rename still lands on
          // reconnect. Close the row instead, and paint the name and colour
          // that were typed, the same optimistic paint the delete branch
          // below makes for the same reason. `nameInput.maxLength` is what
          // lets `.trim()` alone agree with `parseCategory`'s trim-then-cap
          // (nothing longer can be in the box), and a rename refused on
          // replay — a 409 for a name another device took meanwhile — is
          // taken back by the reconnect flush's own reload. An empty box is
          // left alone rather than painted: the server will refuse it, and a
          // nameless row is not a better guess than the name still there.
          if (err.queued) {
            editingCategoryId = null;
            const local = state.categories.find((x) => x.id === c.id);
            const typed = nameInput.value.trim();
            if (local && typed) {
              local.name = typed;
              local.color = colorInput.value;
            }
            repaintCategories();
          }
          categoryHint(err.message, !err.queued);
        }
      });

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-sm';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        editingCategoryId = null;
        renderCategoryManage();
      });

      // Enter in the rename box means this row's Save, never the habit form's
      // — see `enterPresses`. Wired after `save` exists rather than beside the
      // input, because the whole point is that the key goes to the button.
      enterPresses(nameInput, save);

      li.append(nameInput, colorInput, save, cancel);
    } else {
      const swatch = document.createElement('span');
      swatch.className = 'category-swatch';
      swatch.style.backgroundColor = c.color;

      const name = document.createElement('span');
      name.className = 'category-manage-name';
      name.textContent = c.name;

      // Absent entirely below two categories — see `canReorder` above —
      // rather than merely disabled, so an account with one category shows
      // no arrows to press in the first place.
      let up = null;
      let down = null;
      if (canReorder) {
        up = document.createElement('button');
        up.type = 'button';
        up.className = 'btn btn-icon category-move-up';
        up.title = `Move ${c.name} up`;
        up.setAttribute('aria-label', `Move ${c.name} up`);
        up.textContent = '↑';
        up.dataset.focusKey = `catmove:up:${c.id}`;
        // Disabled at the first row (nowhere to move to) and — because
        // `repaintCategories` refuses to rebuild this list while a rename
        // box is open — disabled on EVERY row whenever one is mid-rename.
        // Left enabled there, a press would send a write and repaint
        // nothing: the row stays exactly where it was with no sign the
        // click did anything, which is the silent-failure class this repo
        // names most often.
        up.disabled = i === 0 || editingCategoryId != null;
        up.addEventListener('click', () => moveCategory(c.id, -1));

        down = document.createElement('button');
        down.type = 'button';
        down.className = 'btn btn-icon category-move-down';
        down.title = `Move ${c.name} down`;
        down.setAttribute('aria-label', `Move ${c.name} down`);
        down.textContent = '↓';
        down.dataset.focusKey = `catmove:down:${c.id}`;
        // Same two reasons as ↑ above, mirrored at the last row.
        down.disabled = i === state.categories.length - 1 || editingCategoryId != null;
        down.addEventListener('click', () => moveCategory(c.id, 1));
      }

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn btn-icon category-edit';
      edit.title = 'Rename or recolour';
      edit.setAttribute('aria-label', `Edit ${c.name}`);
      edit.textContent = '✎';
      edit.addEventListener('click', () => {
        editingCategoryId = c.id;
        renderCategoryManage();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-icon category-delete';
      remove.title = 'Delete category';
      remove.setAttribute('aria-label', `Delete ${c.name}`);
      remove.textContent = '✕';
      remove.addEventListener('click', async () => {
        try {
          await api(`/categories/${c.id}`, { method: 'DELETE' });
          // ON DELETE SET NULL (db.js): its habits survive, uncategorised. If
          // this form was pointed at the category just removed, it follows
          // that back to "(none)" so Save cannot submit an id that no longer
          // exists — and it does so with NO argument, because the refetched
          // list is what answers this rather than anything captured here. A
          // deleted id is not in the list, so `known` is false and the
          // control falls to "(none)" on its own; any OTHER id still is, and
          // is kept. This used to compute the answer eagerly instead
          // (`form.category_id.value === String(c.id) ? null : …`), which was
          // right about the outcome and wrong about the timing — see
          // `refreshCategoryPicker`.
          await refreshCategoryPicker();
          announce();
        } catch (err) {
          // Queued is not failed — see the rename handler above. But saying so
          // is not enough here, because a queued DELETE is DURABLE and will
          // land: `api()` stages it before the attempt and nothing dequeues on
          // a later click. Leave the control offering this category and
          // `saveHabit` reads `currentCategoryId()` as its id, so the habit's
          // own `PUT` queues behind the delete and replays AFTER it — where
          // `resolveCategoryId` answers 400 and `offline.js` drops every 4xx as
          // permanently inapplicable. `PUT /habits/:id` REPLACES, so what is
          // dropped is the whole habit edit and not merely its category, and
          // the only surface is a "1 change could not be synced" toast that
          // names neither. Dropping the row from `state.categories` and
          // repainting is the same optimistic paint on a queued write that
          // `recordValue` already makes, and `ON DELETE SET NULL` is what makes
          // it the answer the server will agree with; the dashboard behind this
          // dialog is reconciled by the reconnect flush's own `emit('reload')`
          // (`ui/connectivity.js`), which is also what takes this back if the
          // replay is refused.
          if (err.queued) {
            state.categories = state.categories.filter((x) => x.id !== c.id);
            repaintCategories();
          }
          categoryHint(err.message, !err.queued);
        }
      });

      li.append(swatch, name);
      if (canReorder) li.append(up, down);
      li.append(edit, remove);
    }
    list.append(li);
  });
}

/**
 * Refetch the account's categories and redraw both the select and the manage
 * list from them.
 *
 * Called after every mutation this dialog makes, rather than waiting on the
 * 'reload' it also emits: that listener repaints the DASHBOARD behind this
 * (still open) modal, not this form, and `state.categories` is refreshed here
 * too so the dashboard is not one edit behind if it repaints from state
 * before its own reload finishes.
 *
 * **It takes no argument, and that is the fix for a defect this file has now
 * shipped twice.** It used to accept a `selected` id, and every caller
 * evaluated one eagerly — `currentCategoryId()`, read from whichever dialog
 * was open at the click. There is an `await` on the line below, so by the time
 * the render happens that dialog may have been cancelled and another habit's
 * opened in its place, and `renderCategorySelect` would then force the FIRST
 * habit's category onto the second one's control. Press Save on it with
 * nothing else changed and `PUT /habits/:id` REPLACES: the second habit is
 * committed into a category chosen for a different one.
 *
 * Round 2 found exactly this and fixed `openDialog`'s call by passing nothing;
 * the four handlers in this file that also call it were left as they were, so
 * the same bug survived at four sites with a test covering only the fifth.
 * Removing the parameter is what makes it unrepresentable rather than
 * remembered — with no argument, `renderCategorySelect` reads `select.value`
 * at RENDER time, which is whatever dialog is genuinely open, and a late
 * answer can only ever re-confirm it. Nothing is lost by it: a rename changes
 * a name, an add does not assign, and a delete's own "fall back to (none)" is
 * answered by the refetched list not holding the deleted id.
 * `renderCategorySelect`'s explicit-id path now has exactly ONE caller —
 * `openDialog`'s synchronous first render, the only place a wanted id is known
 * to belong to the dialog being drawn, because no `await` separates them.
 */
async function refreshCategoryPicker() {
  const mine = ++state.categoryReadSeq;
  const fetched = await api('/categories');
  // Only the newest read may INSTALL its answer — see `categoryReadSeq`. An
  // older one still repaints, from whatever the store holds now: the
  // assignment is the half that can be stale, and skipping the repaint too
  // would mean an awaiting caller (the rename's `editingCategoryId = null`,
  // say) could be left with controls that do not match the state behind them.
  // A repaint from current state can only ever re-confirm what is there.
  if (mine === state.categoryReadSeq) state.categories = fetched;
  repaintCategories();
}

/**
 * Repaint both category controls from `state.categories` as it stands, with no
 * fetch at all.
 *
 * It is the half of `refreshCategoryPicker` that happens once its GET has
 * landed — and the ONLY half a queued write can have, because offline that GET
 * never lands. Both of this file's queued branches below call it, so "what the
 * two controls show after the list has changed" stays one rule rather than
 * being restated at each of them.
 *
 * The picker is rendered with NO argument, for the reason
 * `refreshCategoryPicker` takes none: see there.
 *
 * A rename row owns an input this rebuild would tear out from under whoever is
 * typing in it — the "`change` never fires on a removed input" failure
 * `shared/public/CLAUDE.md` documents for the settings dialog. Load-bearing for
 * `openDialog`'s fire-and-forget refresh: that continuation can land at any
 * point after the user has moved on to a DIFFERENT habit, or has pressed ✎ on
 * this one, and must not rebuild the list either dialog is showing mid-edit.
 */
function repaintCategories() {
  renderCategorySelect();
  if (editingCategoryId == null) renderCategoryManage();
}

/**
 * Put the keyboard back on the arrow that was just pressed — or park it on the
 * list itself when that very press is what disabled that arrow.
 *
 * Deliberately not `restoreFocus` (ui/components.js), and this is the one
 * place in the app where its fallback is the wrong answer. That fallback hands
 * focus to the first still-operable `[data-focus-key]` in the same PARENT,
 * which is right for its other caller — pressing Today disables Today, and the
 * paging button beside it does something unrelated — and actively wrong in a
 * manage row, where ↑ and ↓ are the only two focus keys and each is the
 * other's undo. Walk a category to the top with repeated Enter presses (the
 * gesture `moveCategory`'s own restore exists for) and the press that lands it
 * at row 0 disables ↑ and moves focus one button right to ↓; the next press
 * sends it back down, and a held Enter ping-pongs the row between the two ends
 * with a `POST /categories/reorder` per step. The only thing saying so is a
 * focus ring shifting about 30px inside a row that was moving anyway.
 *
 * So a boundary parks the keyboard on `#category-manage`. The gesture stops
 * where the boundary says it stops, focus stays inside the dialog rather than
 * dropping to `<body>` — which is the whole reason a restore runs here at all
 * — and the list survives `repaintCategories()`'s `replaceChildren()`, so the
 * post-refetch restore's `activeElement === document.body` guard correctly
 * reads it as focus nobody dropped.
 */
function restoreArrowFocus(list, key) {
  if (!key) return;
  // Compared rather than selected, for the reason `restoreFocus` gives.
  const arrow = [...list.querySelectorAll('[data-focus-key]')]
    .find((el) => el.dataset.focusKey === key);
  if (arrow && !(/** @type {HTMLButtonElement} */ (arrow).disabled)) {
    /** @type {HTMLElement} */ (arrow).focus();
    return;
  }
  list.tabIndex = -1;
  list.focus({ preventScroll: true });
}

/**
 * Shift a category one slot up or down and write the new order.
 *
 * Follows `nudgeHabit` / `persistOrder` (dashboard.js) — optimistic splice,
 * repaint, then the write — with one deliberate difference in the catch
 * below. Module-local and not exported: this is a one-off helper for the two
 * buttons above, not a rule anything else needs, and an export here is a
 * `CACHE_VERSION` bump for nothing (root `CLAUDE.md`).
 *
 * The payload names only the ids THIS client currently holds, so a category
 * created on another device since this dialog's own fetch keeps whatever
 * position it already has — the reorder route's existing semantics, not
 * anything decided here. And rapid presses put several of these writes in
 * flight at once, each carrying the full order at the time it fired;
 * `persistOrder` has the very same exposure, so this does not invent a new
 * mechanism the habit list does not already live with.
 */
async function moveCategory(id, delta) {
  const order = state.categories.map((c) => c.id);
  const from = order.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) return;

  const focused = focusKeyOf(document.activeElement);
  const byId = new Map(state.categories.map((c) => [c.id, c]));
  const previous = state.categories;
  order.splice(to, 0, ...order.splice(from, 1));
  // This press is newer than anything already out on the wire, so retire every
  // category read in flight before installing the optimistic order — see
  // `categoryReadSeq` (ui/store.js). Without it, `openDialog`'s own
  // fire-and-forget refetch (fired before this press existed), a previous
  // press's refetch, or the `/overview` a sibling handler's `announce()` set
  // going could land afterwards and paint the pre-move order back over this
  // one. The number is kept, because the revert below is a writer of
  // `state.categories` too and has to ask the same question.
  const mine = ++state.categoryReadSeq;
  state.categories = order.map((catId) => byId.get(catId));
  const list = $('#category-manage');
  // `.category-manage` is `max-height: 160px; overflow-y: auto` over up to 30
  // rows, and `list.replaceChildren()` inside `repaintCategories()` clamps
  // `scrollTop` back to 0 on every rebuild — twice here, once per repaint
  // below. What put it back before was `restoreFocus`'s `.focus()` scrolling
  // the focused element into view, which is not a scroll mechanism: it only
  // worked because a press had already left the arrow focused, true in
  // Chrome (which focuses a `<button>` on mousedown) and not in Safari on
  // macOS or iOS, where both restores below no-op and a press on a row below
  // the fold scrolled the moving row out of view. The browser suites are
  // Chrome-only, so nothing there could see this. Save and restore the
  // scroll position explicitly instead, across both repaints.
  const scrollTop = list.scrollTop;
  // Not `renderCategoryManage()` alone — the select's option order has to
  // follow too, and this is the one function that redraws both controls from
  // `state.categories` as it stands.
  repaintCategories();
  list.scrollTop = scrollTop;
  // So holding ↑ walks a category up instead of dropping focus on the first
  // press — `repaintCategories()` just tore out the button that was focused
  // and built a new one under the same `data-focus-key`.
  restoreArrowFocus(list, focused);

  try {
    await api('/categories/reorder', { method: 'POST', body: JSON.stringify({ order }) });
  } catch (err) {
    // `/categories/reorder` is `replayable()` (ui/api.js: everything but
    // `POST /habits`), so offline the write is already staged before this
    // throw and WILL land on reconnect. Reverting the optimistic order here
    // would snap the list back from an order that is about to be applied —
    // the mistake `persistOrder` (dashboard.js) makes for the habit list,
    // which reverts unconditionally, `err.queued` included. That is a real,
    // pre-existing defect there; this is deliberately not a second copy of
    // it.
    //
    // `mine === state.categoryReadSeq` for the same reason the refetch asks
    // it: `previous` was captured before this press's own splice, so it is a
    // stale writer of `state.categories` the moment anything newer has
    // installed an order. Two presses overlapping and the EARLIER one failing
    // last — a 5xx, a dropped connection, or the write limiter's 429, which
    // is what a held arrow key reaches — put an order two presses old back in
    // the store with nothing left in flight to correct it, and the next press
    // wrote that regression to the server. Where something newer HAS run, not
    // reverting is also the more accurate answer: a later press's payload was
    // computed after this splice, so it carries this move whether or not this
    // write landed.
    if (!err.queued && mine === state.categoryReadSeq) {
      state.categories = previous;
      repaintCategories();
    }
    categoryHint(err.message, !err.queued);
    // Only THIS request's own rejection may reach the branch above. Nothing
    // below here may run on this path — see the refetch's own comment for
    // why a failure past this point is a different animal entirely.
    return;
  }

  // The POST has already committed by the time we reach here, so only ITS
  // OWN rejection (the catch above) may revert or paint an error. A refetch
  // that fails on a connection drop, a restart, the service worker's
  // synthetic 503 or the read limiter's own 429 (a separate bucket from the
  // write limiter, `shared/src/security.js`) is not the reorder failing —
  // the server already has the move. Reverting here would snap the list back
  // from an order the next reload would show anyway, and telling the user it
  // failed would be false. `.catch(() => {})` is the same swallow the "add a
  // suggested category" chip handler already uses on its own 409 path, below
  // in this file, for the same shape of problem — a write that is already
  // settled followed by a refetch whose own failure answers nothing about it:
  // the optimistic order already IS the server's own order by then, so there
  // is nothing left to paint and nothing to revert.
  //
  // No argument — see `refreshCategoryPicker`. A reorder never changes
  // which category this form has chosen.
  await refreshCategoryPicker().catch(() => {});
  // `repaintCategories()` (just run, inside `refreshCategoryPicker`) rebuilds
  // the manage list — and clamps `scrollTop` back to 0 — only when
  // `editingCategoryId == null`, the same condition it gates
  // `renderCategoryManage()` on. With a rename box open there was no rebuild
  // and nothing here to correct: forcing the press-time offset regardless
  // used to jump the list under the open rename box the moment this GET
  // landed. (A manual scroll made during the wait, with no rename involved,
  // is not something this line — or the focus guard below, which reads the
  // same `<body>` either way — can tell apart from an untouched
  // wait; this guard only stops the write from firing where it plainly
  // should not, not from ever restoring a stale offset.)
  if (editingCategoryId == null) {
    list.scrollTop = scrollTop;
  }
  // `refreshCategoryPicker`'s own `repaintCategories()` just did a SECOND
  // `list.replaceChildren()` — this time from the server's answer — which
  // drops focus to `<body>` exactly like the optimistic one above did, and
  // nothing restores it after that one. Left alone, a keyboard user only
  // keeps focus while presses outrun the fetch; at a human pace every press
  // loses it, which is the very defect the optimistic restore above claims
  // to have fixed. Restore again here — but ONLY when `<body>` (or nothing)
  // holds focus, i.e. it was this repaint that dropped it. By the time the
  // GET lands the user may have deliberately moved focus elsewhere, and an
  // unconditional restore would steal it back.
  if (document.activeElement == null || document.activeElement === document.body) {
    restoreArrowFocus(list, focused);
  }
  // `emit('change')` directly — the one mutation in this file that
  // deliberately does NOT go through `announce()`. There is nothing to
  // fetch: `refreshCategoryPicker` just set `state.categories` from
  // `GET /categories`, which is the authoritative order, so every listener
  // can simply redraw from what the store already holds. `announce()`
  // would fire `'reload'` here whenever the dashboard is showing, and that
  // is active harm rather than a slower way to the same place —
  // `dashboard.js`'s `load()` overwrites `state.categories` with
  // `/overview`'s answer, a SECOND writer of the same field that can land
  // after a later press has already moved the order again, installing a
  // stale order over the manage list's own newer one.
  emit('change');
}

/** @param habit  null opens the create form */
export function openDialog(habit = null) {
  state.editingId = habit?.id ?? null;
  title.textContent = habit ? 'Edit habit' : 'New habit';
  del.hidden = !habit;

  const f = form;
  f.name.value = habit?.name ?? '';
  f.icon.value = habit?.icon ?? '';
  f.description.value = habit?.description ?? '';
  editingCategoryId = null;
  categoryHint('');
  renderCategorySelect(habit?.category_id ?? null);
  renderCategoryManage();
  f.type.value = habit?.type ?? 'boolean';
  f.unit.value = habit?.unit ?? '';
  f.target_value.value = habit?.target_value ?? 1;
  f.target_type.value = habit?.target_type ?? 'at_least';
  f.at_most_unlogged.value = habit?.at_most_unlogged ?? 'default';
  f.show_as.value = habit?.show_as ?? 'amount';
  f.freq_numerator.value = habit?.freq_numerator ?? 1;
  f.freq_denominator.value = habit?.freq_denominator ?? 1;
  f.color.value = habit?.color ?? '#3b82f6';
  reminderField.set(habit?.reminder_time ?? '');
  f.reminder_message.value = habit?.reminder_message ?? '';
  f.archived.checked = !!habit?.archived;
  archivedWrap.hidden = !habit; // only meaningful for an existing habit

  syncTypeFields();
  dialog.showModal();
  f.name.focus();

  // `state.categories` can still be the boot default of `[]` here — the
  // deep-link path this dialog exists to fix runs no `dashboard.load()`
  // before it — so drive a real fetch rather than trust whatever happened to
  // be in state already. Not awaited: the dialog opens on whatever is
  // rendered above (never savable-but-wrong, thanks to the guard in
  // `renderCategorySelect`) instead of spinning on a network round trip, and
  // OFFLINE this simply never resolves — which is exactly the case that
  // guard, not this call, is what protects. Failure is swallowed rather than
  // surfaced: the picker already shows something correct either way, so
  // there is nothing actionable to tell the user about a fetch they did not
  // ask for.
  //
  // Called with NO argument, deliberately, and not with `habit?.category_id`
  // eagerly captured here: this promise settles whenever the GET lands, which
  // can be after Escape, after a different habit's dialog has opened, or
  // after a hand change to the control — none of which this closure can see,
  // since it captured nothing about which dialog is open when it resolves.
  // `renderCategorySelect(undefined)` reads `select.value` AT RENDER TIME
  // instead, which is whatever the live dialog is actually showing in every
  // one of those cases, so the late answer can only ever re-confirm the
  // control's own current value rather than force a stale one over it. The
  // cold deep link above still resolves to the real name: this function's own
  // synchronous `renderCategorySelect(habit?.category_id ?? null)` has
  // already put the real id in the control as the placeholder's value, so
  // when `state.categories` lands moments later the undefined-wanted render
  // finds that same id in the now-populated list and swaps the placeholder
  // for the real name — see `renderCategorySelect`'s own doc comment for why
  // an explicit `wanted` and a read-back `select.value` agree here.
  refreshCategoryPicker().catch(() => {});
}

function syncTypeFields() {
  const numerical = form.type.value === 'numerical';
  form.querySelector('.numerical-only').hidden = !numerical;
  // Shown only for a limit, where a day nobody answered has two defensible
  // readings because zero is under the target. Hidden is not cleared: the
  // value is still submitted, so switching Goal back and forth in one sitting
  // does not silently discard an answer the user already gave.
  // Both at-most controls, not one — `querySelector` found only the first, so
  // adding the second left it permanently hidden.
  for (const el of form.querySelectorAll('.at-most-only')) {
    el.hidden = !numerical || form.target_type.value !== 'at_most';
  }
}

async function saveHabit(e) {
  e.preventDefault();
  const f = form;

  // The reminder box accepts free text, so it is the one field that can hold
  // something unsaveable. Refuse here rather than sending '' and silently
  // dropping the reminder the user thought they had just set.
  const reminderTime = reminderField.value();
  if (reminderTime === null) {
    reminderField.hint(
      `"${f.reminder_time.value}" is not a time — try 08:30, 8:30 pm or 2030.`, true);
    reminderField.focus();
    return;
  }

  const payload = {
    name: f.name.value,
    icon: f.icon.value,
    description: f.description.value,
    // A number or null, never '' — parseHabit reads anything else as no
    // category, and PUT /habits/:id REPLACES, so an omitted category_id would
    // clear one that was already set.
    category_id: currentCategoryId(),
    type: f.type.value,
    unit: f.unit.value,
    target_value: Number(f.target_value.value) || 0,
    target_type: f.target_type.value,
    at_most_unlogged: f.at_most_unlogged.value,
    show_as: f.show_as.value,
    freq_numerator: Number(f.freq_numerator.value) || 1,
    freq_denominator: Number(f.freq_denominator.value) || 1,
    color: f.color.value,
    // Normalised by the picker, so '8:30 pm' reaches the server as '20:30' and
    // an empty field as '' — which the validator reads as "no reminder".
    reminder_time: reminderTime,
    reminder_message: f.reminder_message.value,
    archived: f.archived.checked,
  };

  try {
    // Both routes answer with the STORED habit in both editions, and the reply
    // is what the rule below is asked about rather than what was sent. They
    // differ: `parseHabit` clamps `description` to `LIMITS.description`, so a
    // 600-character description whose only mention of the query sits past the
    // cut matches the request and not the row — and the box then survives over a
    // list the habit has just left. It is the same reading `applyImport` got
    // wrong the other way round, asking the file's word for something instead of
    // what it would mean here.
    let saved;
    if (state.editingId) {
      saved = await api(`/habits/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Habit updated');
    } else {
      saved = await api('/habits', { method: 'POST', body: JSON.stringify(payload) });
      toast('Habit created');
    }
    dialog.close();
    // Land back where the edit was started — `announce`, whose note has the
    // whole rule. Editing a habit from its own page and being returned to the
    // dashboard loses your place for no reason, and the flags it reads are
    // still whatever they were, because a modal dialog repaints nothing behind
    // it. Creating from the dashboard still needs 'reload': a repaint alone
    // would draw the old list without the habit that was just made.
    // The dashboard's search filter goes only when what was just saved would be
    // OFF the list: a habit the user is told about and cannot see is the thing
    // #74 protects against, and clearing on anything else is the opposite
    // failure — a filter wiped by something that replaced nothing.
    //
    // Three saves can take it off, and only the first is obvious. A CREATE,
    // because the new habit need not match the query. An EDIT that changed the
    // name or the description, because the habit you were looking at may no
    // longer match — the same disappearance arriving from the other side, and
    // the reason "this was a create" is the tempting simpler rule and the wrong
    // one; it is reachable only from a habit's own page, where Edit lives. And
    // ARCHIVING, which does not touch either matched field and removes the row
    // anyway, because the dashboard fetches active habits or archived ones and
    // never both. `staysOnList` is all three as one question.
    //
    // It re-tests the MATCH rather than comparing the name with what was there
    // before, for two reasons. The filter reads the description as well, so
    // "did the name change" is blind to a habit found by its second field. And
    // the match answers the near-misses for free: an edit that leaves the habit
    // on the list clears nothing at all, where a name comparison would clear
    // harmlessly but pointlessly, and a save with no query in the box is a
    // no-op rather than a write and a repaint.
    //
    // Cleared at the mutators that actually replace the list rather than in the
    // dashboard's 'reload' listener. That event has ten emitters and only half
    // of them replace anything, so clearing there also wiped the box on Back
    // from a habit and on a background reconnect, mid-word. `dashboard.js`'s
    // archive toggle already works this way.
    if (!staysOnList(saved)) state.query = '';
    announce();
  } catch (err) {
    toast(err.message);
    // A create that timed out is the one failure nobody here can classify: the
    // request was abandoned, not recalled, so the habit may exist. Closing and
    // reloading is what turns "check whether it was created" from an
    // instruction into something the user can just see — and leaving the dialog
    // open over a list that might already hold the habit is how they make a
    // second one.
    if (err.indeterminate) {
      dialog.close();
      // Unconditional, where the success path above asks whether the habit
      // would be visible: nobody here knows what landed, so the payload is not
      // evidence about the list. Showing everything is the only answer that is
      // right whichever way the abandoned request went.
      state.query = '';
      emit('reload');
    }
  }
}

async function deleteHabit() {
  if (!state.editingId) return;
  const id = state.editingId;

  try {
    // Snapshot the habit and its history first, so the delete can be undone
    // without a soft-delete column or a server-side trash.
    const habit = await api(`/habits/${id}`);
    const entries = await api(`/habits/${id}/entries`);

    // The delete is undoable from the toast that follows, so the confirm is
    // a preference rather than a safety requirement.
    if (settings.get('confirmDelete') && !confirm(
      `Delete "${habit.name}" and its ${entries.length} recorded ` +
      `${entries.length === 1 ? 'day' : 'days'}?`
    )) return;

    await api(`/habits/${id}`, { method: 'DELETE' });
    dialog.close();
    // `staysOnList` of a habit that no longer exists is false however the
    // account is set up, so this constant IS the rule above, resolved in
    // advance rather than a second rule. Left as it stands, the filtered list
    // the delete emptied reads "No habits match that." over a delete that
    // succeeded.
    state.query = '';
    emit('reload');

    toast(`Deleted "${habit.name}"`, {
      actionLabel: 'Undo',
      onAction: () => restoreHabit(habit, entries),
    });
  } catch (e) {
    toast(e.message);
  }
}

/** Recreate a deleted habit and replay its entries. */
async function restoreHabit(habit, entries) {
  try {
    const created = await api('/habits', {
      method: 'POST',
      body: JSON.stringify(habit),
    });

    // Restore history in one import rather than a request per day.
    if (entries.length) {
      const payload = { habits: [{ ...created, entries }] };
      const res = await fetch('/api/import?mode=merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'could not restore history');
      }
    }

    // An undo is a create, and it has the created habit in hand, so it asks the
    // same question `saveHabit` does rather than borrowing the delete's answer.
    // The delete above is unconditional because a deleted habit is off the list
    // whatever the account is set to; this one is not, and a restore whose habit
    // is still on screen under the query in the box should leave it alone.
    if (!staysOnList(created)) state.query = '';
    emit('reload');
    toast(`Restored "${habit.name}"`);
  } catch (e) {
    toast(`Could not undo: ${e.message}`);
  }
}

export function init() {
  $('#btn-new').addEventListener('click', () => openDialog());
  $('#dialog-cancel').addEventListener('click', () => dialog.close());
  del.addEventListener('click', deleteHabit);
  form.addEventListener('submit', saveHabit);
  form.type.addEventListener('change', syncTypeFields);
  // The limit control's visibility depends on the Goal too, so both inputs
  // have to re-ask. Without this, switching to "At most" left the question
  // hidden until the dialog was reopened.
  form.target_type.addEventListener('change', syncTypeFields);

  // Built once — the six suggestions are static — mirroring how
  // reminder-field.js builds its own preset row at load rather than per open.
  const chips = $('#category-chips');
  for (const s of CATEGORY_SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn btn-sm category-chip';
    chip.style.setProperty('--chip-color', s.color);
    chip.textContent = s.name;
    chip.addEventListener('click', async () => {
      try {
        const cat = await api('/categories', {
          method: 'POST',
          body: JSON.stringify({ name: s.name, color: s.color }),
        });
        // No argument — see `refreshCategoryPicker`. Creating a category
        // does not assign it (the chip is a shortcut to HAVING one, not to
        // wearing it), so this form's own selection is unchanged and reading
        // it back at render time is the only reading that is still true when
        // the refetch lands.
        await refreshCategoryPicker();
        announce();
        categoryHint(`Added "${cat.name}" — pick it above to use it.`);
      } catch (err) {
        // The account already holds this name in some casing, which is not a
        // failure the user has to do anything about: the category the chip
        // was reaching for exists. Refresh the picker — that is what puts it
        // in the list when it was created on another device — and say to pick
        // it, in the ordinary hint class rather than the error one.
        //
        // Deliberately NOT resolved to the existing row and selected for
        // them. Finding it means asking which stored name IS this one, which
        // is `foldCategoryName` (shared/src/validate.js) — and `shared/src`
        // is not served to the browser, so having the answer here at all
        // means a third hand-written copy of the rule the two editions' routes
        // share. This client does not earn one: a mirror is for a rule that
        // must work with no network (the tap cycle, `needsReminder`), and this
        // branch is unreachable offline, where the POST is queued and throws
        // `err.queued` instead of ever seeing a 409. One click is the whole
        // cost, and only for a name the account already has.
        //
        // Matched on the server's own sentence because that is all `api()`
        // keeps of a failed response (`shared/public/ui/api.js` throws
        // `new Error(body.error)`); both editions answer this route with that
        // exact literal, and both have a test on the 409.
        if (err.message === 'category already exists') {
          await refreshCategoryPicker().catch(() => {});
          categoryHint(`"${s.name}" already exists — pick it above to use it.`);
          return;
        }
        // `err.queued` is the outbox working, not a failure — see the
        // `category-new-add` handler below for the whole reasoning.
        categoryHint(err.message, !err.queued);
      }
    });
    chips.append(chip);
  }

  // Enter in the "New category" box means Add, never the habit form's Save —
  // see `enterPresses`. Wired once, here, for the reason the chips are built
  // once: neither depends on which habit the dialog is showing.
  enterPresses($('#category-new-name'), $('#category-new-add'));

  $('#category-new-add').addEventListener('click', async () => {
    const nameField = $('#category-new-name');
    const name = nameField.value.trim();
    if (!name) {
      categoryHint('Type a name for the new category.', true);
      return;
    }
    try {
      const cat = await api('/categories', {
        method: 'POST',
        body: JSON.stringify({ name, color: $('#category-new-color').value }),
      });
      nameField.value = '';
      // No argument — see `refreshCategoryPicker`, and the chip handler above.
      await refreshCategoryPicker();
      announce();
      categoryHint(`Added "${cat.name}" — pick it above to use it.`);
    } catch (err) {
      // A queued write is the outbox doing its job, not an error: `api()`
      // marks it `queued` (shared/public/ui/api.js), and "Saved offline —
      // will sync when you reconnect" read in the error class made the one
      // path that is actually working look like the one that is broken.
      categoryHint(err.message, !err.queued);
    }
  });
}
