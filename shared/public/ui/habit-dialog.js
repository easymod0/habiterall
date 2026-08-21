/**
 * Create, edit, delete and undelete a habit.
 *
 * Owns `#habit-dialog` and its form, plus the "New habit" button that opens
 * it. Announces `'reload'` when it changes something, so it never has to know
 * which view is showing.
 */

import { api } from '/shared/ui/api.js';
import { reminderField } from '/shared/ui/reminder-field.js';
import * as settings from '/shared/ui/settings.js';
import { emit, staysOnList, state } from '/shared/ui/store.js';
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

function categoryHint(message, isError = false) {
  const hint = $('#category-hint');
  hint.textContent = message;
  hint.classList.toggle('error', isError);
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
 * @param {number | null} [wanted]
 */
function renderCategorySelect(wanted) {
  const select = form.category_id;
  const want = wanted != null ? String(wanted) : select.value;
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
  select.value = state.categories.some((c) => String(c.id) === want) ? want : '';
}

/** The manage list: one row per category, ✎ for rename+recolour, ✕ to delete. */
function renderCategoryManage() {
  const list = $('#category-manage');
  list.replaceChildren();

  for (const c of state.categories) {
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
          await refreshCategoryPicker(currentCategoryId());
          emit('reload');
        } catch (err) {
          categoryHint(err.message, true);
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

      li.append(nameInput, colorInput, save, cancel);
    } else {
      const swatch = document.createElement('span');
      swatch.className = 'category-swatch';
      swatch.style.backgroundColor = c.color;

      const name = document.createElement('span');
      name.className = 'category-manage-name';
      name.textContent = c.name;

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
          // this form was pointed at the category just removed, follow that
          // back to "(none)" so Save cannot submit an id that no longer
          // exists.
          const keep = form.category_id.value === String(c.id)
            ? null : currentCategoryId();
          await refreshCategoryPicker(keep);
          emit('reload');
        } catch (err) {
          categoryHint(err.message, true);
        }
      });

      li.append(swatch, name, edit, remove);
    }
    list.append(li);
  }
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
 * @param {number | null} [selected]  category to keep selected, if it exists
 */
async function refreshCategoryPicker(selected) {
  state.categories = await api('/categories');
  renderCategorySelect(selected);
  renderCategoryManage();
}

/**
 * Create a category by name, or hand back the one that already answers to it
 * (by any casing) — a suggestion chip is a shortcut to get started, not a
 * second way to hit the 409 a typed duplicate gets.
 *
 * @param {string} name
 * @param {string} color
 */
async function useOrCreateCategory(name, color) {
  try {
    return await api('/categories', { method: 'POST', body: JSON.stringify({ name, color }) });
  } catch (err) {
    if (err.message !== 'category already exists') throw err;
    const existing = (await api('/categories'))
      .find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    throw err;
  }
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
    // Land back where the edit was started. Editing a habit from its own page
    // and being returned to the dashboard loses your place for no reason —
    // 'change' reloads whichever view is showing, and `openHabitId` is still
    // set because a modal dialog repaints nothing behind it. Creating from the
    // dashboard still needs 'reload': a repaint alone would draw the old list
    // without the habit that was just made.
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
    emit(state.openHabitId != null ? 'change' : 'reload');
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
        const cat = await useOrCreateCategory(s.name, s.color);
        await refreshCategoryPicker(currentCategoryId());
        emit('reload');
        categoryHint(`Added "${cat.name}" — pick it above to use it.`);
      } catch (err) {
        categoryHint(err.message, true);
      }
    });
    chips.append(chip);
  }

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
      await refreshCategoryPicker(currentCategoryId());
      emit('reload');
      categoryHint(`Added "${cat.name}" — pick it above to use it.`);
    } catch (err) {
      categoryHint(err.message, true);
    }
  });
}
