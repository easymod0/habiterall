/**
 * The settings dialog, built from the registry in `ui/settings.js` so adding
 * an option needs no changes here.
 *
 * Owns `#settings-dialog`, its body, and the gear that opens it.
 *
 * Nothing is written until Done. The dialog edits a *draft* — a copy of the
 * current values taken when it opens — and Cancel throws it away. Escape does
 * the same thing for free, which it did not before: closing the dialog used to
 * leave every change already saved, so there was no way to back out of one.
 *
 * The draft also drives the dependent controls (`requires`), so switching
 * Discord on still reveals its webhook field immediately even though nothing
 * has been stored yet.
 */

import { openDataDialog } from '/shared/ui/data-dialog.js';
import * as settings from '/shared/ui/settings.js';
import { emit, set } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';

const $ = (sel) => document.querySelector(sel);

const dialog = $('#settings-dialog');
const body = $('#settings-body');
const doneBtn = $('#settings-close');
const cancelBtn = $('#settings-cancel');
const resetBtn = $('#settings-reset');

/** Values being edited. Replaced wholesale each time the dialog opens. */
let draft = {};
/** What the draft looked like on open, for "has anything changed?". */
let baseline = '{}';
/** Reset is staged like everything else, so Cancel undoes it too. */
let pendingReset = false;
/** Suppresses the onChange redraw while we are the ones doing the writing. */
let applying = false;
/** Section actions rendered this pass, so they can be disabled while dirty. */
let actionButtons = [];

function isDirty() {
  return pendingReset || JSON.stringify(draft) !== baseline;
}

/** Which controls `requires` currently admits — a rebuild is only needed when this changes. */
function visibleKeys(values) {
  return Object.keys(settings.SETTINGS)
    .filter((key) => settings.visible(key, values))
    .join(',');
}

/**
 * Record a change against the draft.
 *
 * The body is rebuilt only when the change makes a control appear or
 * disappear. Rebuilding on every edit would tear the control out from under
 * the user mid-interaction — and for a text field, take its focus with it.
 */
function stage(key, value) {
  const before = visibleKeys(draft);
  draft[key] = value;
  if (visibleKeys(draft) !== before) renderSettingsBody();
  else refreshFooter();
}

function renderSettingsBody() {
  body.replaceChildren();
  actionButtons = [];

  for (const section of settings.sections()) {
    const group = document.createElement('section');
    group.className = 'data-section';

    const heading = document.createElement('h3');
    heading.textContent = section;
    group.append(heading);

    // Above the controls, not below them: this is the answer to "why am I not
    // getting my reminders?", which is the question that brought the user here.
    // Read from the DRAFT, so switching a destination off makes its warning go
    // away immediately rather than after a save and a refetch.
    for (const problem of settings.SECTION_NOTICES[section]?.(draft) ?? []) {
      const notice = document.createElement('p');
      notice.className = 'hint setting-help setting-problem';
      notice.textContent = problem;
      group.append(notice);
    }

    for (const [key, def] of Object.entries(settings.SETTINGS)) {
      if ((def.section ?? 'General') !== section) continue;
      // A control whose prerequisite is off is left out entirely rather than
      // disabled: the value is still stored, so nothing is lost by hiding it.
      if (!settings.visible(key, draft)) continue;

      const label = document.createElement('label');
      label.className = def.type === 'toggle' ? 'checkbox' : '';
      // A stable id per setting. The dialog needs none of it — the control is
      // inside its own <label> — but it means a test can name the field it
      // means rather than counting inputs, which silently retargets the moment
      // a setting is added above it.
      const controlId = `setting-${key}`;

      if (def.type === 'select') {
        const text = document.createElement('span');
        text.textContent = def.label;
        const select = document.createElement('select');
        select.id = controlId;
        // A stored value the option list does not carry still has to be
        // selectable, or the dialog would show the default and saving anything
        // else would quietly discard what the server had.
        const options = def.options.some((o) => o.value === draft[key])
          ? def.options
          : [{ value: draft[key], label: String(draft[key]) }, ...def.options];
        for (const opt of options) {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          o.selected = draft[key] === opt.value;
          select.append(o);
        }
        select.addEventListener('change', () => stage(key, select.value));
        label.append(text, select);
      } else if (def.type === 'multi') {
        // A fieldset rather than nested labels: each destination is its own
        // checkbox, and the group needs one accessible name of its own.
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'setting-multi';
        const legend = document.createElement('legend');
        legend.textContent = def.label;
        fieldset.append(legend);

        for (const opt of def.options) {
          const row = document.createElement('label');
          row.className = 'checkbox';
          const box = document.createElement('input');
          box.id = `${controlId}-${opt.value}`;
          box.type = 'checkbox';
          box.checked = (draft[key] ?? []).includes(opt.value);
          box.addEventListener('change', () => {
            // Read the draft at event time, never a value captured during
            // render: the body is no longer rebuilt after every change, so a
            // captured list goes stale the moment a second box is ticked and
            // the first tick would be dropped.
            const chosen = Array.isArray(draft[key]) ? draft[key] : [];
            const next = def.options
              .map((o) => o.value)
              .filter((v) => (v === opt.value ? box.checked : chosen.includes(v)));
            stage(key, next);
          });
          const text = document.createElement('span');
          text.textContent = opt.label;
          row.append(box, text);
          fieldset.append(row);
        }
        group.append(fieldset);
        if (def.help) group.append(settingHelp(def.help));
        continue;                       // no outer <label> for a group
      } else if (def.type === 'text') {
        const text = document.createElement('span');
        text.textContent = def.label;
        const input = document.createElement('input');
        input.id = controlId;
        input.type = 'text';
        input.value = draft[key] ?? '';
        if (def.placeholder) input.placeholder = def.placeholder;
        // `change`, not `input`: a URL is pasted a character at a time as far
        // as `input` is concerned, and staging each character would flicker
        // the dependent controls it gates.
        input.addEventListener('change', () => stage(key, input.value.trim()));
        label.append(text, input);
      } else {
        const box = document.createElement('input');
        box.id = controlId;
        box.type = 'checkbox';
        box.checked = !!draft[key];
        box.addEventListener('change', () => stage(key, box.checked));
        const text = document.createElement('span');
        text.textContent = def.label;
        label.append(box, text);
      }

      group.append(label);

      if (def.help) group.append(settingHelp(def.help));
    }

    for (const action of settings.SECTION_ACTIONS[section] ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          toast(await action.run());
        } catch (e) {
          toast(e.message);
        } finally {
          button.disabled = false;
          refreshFooter();
          // A test is a real delivery attempt, so it is also the answer to
          // "is it fixed yet?" — this is what clears the notice above once a
          // replacement webhook works, rather than waiting for tomorrow.
          refreshDeliveryNotices();
        }
      });
      actionButtons.push(button);
      group.append(button);
    }

    body.append(group);
  }

  body.append(backupSection());

  refreshFooter();
}

/**
 * Backup and restore, at the foot of the dialog.
 *
 * Not from the registry, and deliberately: it is not a setting, it has nothing
 * to store, and `sections()` is derived from `SETTINGS` — a section with no
 * entries in it never renders at all. It is here because the top bar was four
 * buttons and a brand on a 360px phone, and this was the one that could move.
 *
 * The backup dialog opens ON TOP of this one rather than replacing it. Closing
 * settings to make room would throw the draft away, so a trip to the backup
 * screen would silently discard whatever had just been typed; stacked, closing
 * it puts you back in settings where you were. It is also not a
 * `SECTION_ACTIONS` entry, which would disable it while the draft is dirty:
 * that rule exists because those ask the SERVER to act on stored settings, and
 * this asks the browser to open a dialog.
 */
function backupSection() {
  const group = document.createElement('section');
  group.className = 'data-section';

  const heading = document.createElement('h3');
  heading.textContent = 'Backup & Restore';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  // Named so a test can ask for it rather than counting buttons, exactly as
  // the settings controls are.
  button.id = 'settings-backup';
  button.textContent = 'Back up or restore…';
  button.addEventListener('click', openDataDialog);

  group.append(
    heading,
    settingHelp('Export everything as JSON, CSV or a Loop backup — or import one back.'),
    button,
  );
  return group;
}

/**
 * Reflect the draft's state in the footer and the section actions.
 *
 * A section action asks the SERVER to do something with the settings it
 * holds — "send a test notification" posts to the webhook that is stored, not
 * the one just typed. Running it against a stale value and reporting success
 * is worse than refusing, so it waits for Done.
 */
function refreshFooter() {
  const dirty = isDirty();
  for (const button of actionButtons) {
    button.disabled = dirty;
    button.title = dirty ? 'Press Done to save your changes first' : '';
  }
}

function settingHelp(textContent) {
  const help = document.createElement('p');
  help.className = 'hint setting-help';
  help.textContent = textContent;
  return help;
}

export function openSettings() {
  draft = structuredClone(settings.load());
  baseline = JSON.stringify(draft);
  pendingReset = false;
  renderSettingsBody();
  dialog.showModal();

  refreshDeliveryNotices();
}

/**
 * Ask how the last reminder went, and redraw if the answer has anything to say.
 *
 * Not awaited by `openSettings`: the dialog opens now and the notice appears a
 * moment later. Waiting on a request first would make every open feel slow to
 * spare the one that has something to report — and offline it would never open.
 *
 * The redraw is conditional for the reason `stage` rebuilds sparingly: rebuilding
 * the body tears every control out and takes a text field's focus with it, so a
 * late answer must not do that to someone already typing. A clean draft means
 * nobody has started.
 */
function refreshDeliveryNotices() {
  // Every section's notices, not just the one that has any today: the body is
  // rendered from the whole registry, so reading a single key here would leave
  // a second entry drawn on open and never redrawn when its answer landed.
  const snapshot = () => JSON.stringify(
    Object.values(settings.SECTION_NOTICES).map((notices) => notices(draft))
  );

  const before = snapshot();
  settings.refreshDelivery().then(() => {
    if (!dialog.open || isDirty()) return;
    if (snapshot() === before) return;
    renderSettingsBody();
  });
}

/**
 * Write the draft, and say so when the server would not take part of it.
 *
 * Partial, deliberately: the endpoint takes a patch and ignores what it will
 * not accept rather than failing the lot, and a webhook URL cannot be judged
 * here — its real rule is a host allowlist that lives with the fetch. So the
 * good values land, the dialog stays open on anything refused, and the fields
 * redraw from what was actually *stored*. A URL that snaps back to blank is
 * how the user learns it was rejected, instead of finding out at 08:00
 * tomorrow.
 */
async function applyDraft() {
  applying = true;
  doneBtn.disabled = true;
  try {
    if (pendingReset) {
      await settings.reset();
      pendingReset = false;
    }

    const current = settings.load();
    const changed = {};
    for (const key of Object.keys(settings.SETTINGS)) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(current[key])) {
        changed[key] = draft[key];
      }
    }

    let ignored = [];
    if (Object.keys(changed).length) {
      const result = await settings.saveAll(changed);
      if (!result.ok) {
        toast(result.error);
        return false;
      }
      ignored = result.ignored;
    }

    // Settings with an in-place control keep a session override, and choosing
    // a value here is the more deliberate act — without clearing it the dialog
    // appears to do nothing once a toggle has been touched.
    const overrides = {};
    if ('calendarZoom' in changed) overrides.calZoom = null;
    if ('historyGranularity' in changed) overrides.granularity = null;
    if ('historyMode' in changed) overrides.historyMode = null;
    if ('scoreGranularity' in changed) overrides.scoreGranularity = null;

    if (ignored.length) {
      const names = ignored.map((key) => settings.SETTINGS[key]?.label ?? key);
      toast(`Not saved: ${names.join(', ')}`);
      // Redraw from what the server actually holds, so the refused field shows
      // the stored value rather than the one that was turned away.
      draft = structuredClone(settings.load());
      baseline = JSON.stringify(draft);
      renderSettingsBody();
      set(overrides);
      return false;
    }

    set(overrides);   // merges the cleared overrides and repaints the open view
    return true;
  } finally {
    applying = false;
    doneBtn.disabled = false;
  }
}

export function init() {
  $('#btn-settings').addEventListener('click', openSettings);

  doneBtn.addEventListener('click', async () => {
    if (await applyDraft()) dialog.close();
  });

  // Cancel throws the draft away. Nothing was written, so there is nothing to
  // undo — which is the whole point of holding one.
  cancelBtn.addEventListener('click', () => dialog.close());

  resetBtn.addEventListener('click', () => {
    pendingReset = true;
    draft = settings.defaults();
    renderSettingsBody();
  });

  // The server may store something other than what was sent — a webhook URL
  // keeps its host and loses its query string. Redraw when that happens, but
  // never on top of edits in progress: the user's unsaved work outranks a
  // background correction, and during our own write we redraw explicitly.
  settings.onChange(() => {
    if (!dialog.open || applying || isDirty()) return;
    draft = structuredClone(settings.load());
    baseline = JSON.stringify(draft);
    renderSettingsBody();
  });
}
