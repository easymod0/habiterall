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
import { emit, set, state } from '/shared/ui/store.js';
import { currentTheme } from '/shared/ui/theme.js';
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
  else {
    refreshFooter();
    // ...and what a section SAYS follows the draft too, which a rebuild used to
    // be the only way to reach. Some changes alter a notice without altering
    // which controls are shown — switching the browser destination on is one,
    // and it is the case where the notice is the entire answer — so those
    // showed nothing at all until something else forced a rebuild.
    paintNotices();
  }
}

/**
 * Repaint what the sections SAY, touching no control.
 *
 * Split out of `renderSettingsBody` because a notice arrives on somebody
 * else's schedule — `GET /api/notify/status` answers when it answers, and a
 * permission prompt is answered when the user gets round to it — and a full
 * rebuild at those moments tears every control out and takes a text field's
 * focus and CONTENT with it. Measured: Discord on, tick the browser
 * destination, type a webhook URL without blurring, then answer the prompt, and
 * the field is empty with focus on `<body>`. `change` never fires on a removed
 * input, so the URL was gone with nothing to say so.
 *
 * The notices stay direct children of the section rather than moving into a
 * wrapper, because the thing being asserted about them is their POSITION among
 * the controls — see `settingscheck.mjs`.
 */
function paintSectionNotices(group) {
  for (const stale of [...group.querySelectorAll(':scope > .setting-problem')]) {
    stale.remove();
  }

  const heading = group.firstElementChild;
  if (!heading) return;

  // Read from the DRAFT, so switching a destination off makes its warning go
  // away immediately rather than after a save and a refetch.
  const lines = settings.SECTION_NOTICES[group.dataset.section]?.(draft) ?? [];
  heading.after(...lines.map((problem) => {
    const notice = document.createElement('p');
    notice.className = 'hint setting-help setting-problem';
    notice.textContent = problem;
    return notice;
  }));
}

/** Every section's notices. The backup block has none and is skipped. */
function paintNotices() {
  for (const group of body.querySelectorAll('.data-section[data-section]')) {
    paintSectionNotices(group);
  }
}

function renderSettingsBody() {
  body.replaceChildren();
  actionButtons = [];

  for (const section of settings.sections()) {
    const group = document.createElement('section');
    group.className = 'data-section';
    // Named so `paintNotices` can find its way back here without rebuilding.
    group.dataset.section = section;

    const heading = document.createElement('h3');
    heading.textContent = section;
    group.append(heading);

    // Above the controls, not below them: this is the answer to "why am I not
    // getting my reminders?", which is the question that brought the user here.
    paintSectionNotices(group);

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

            // An option may need a USER GESTURE, and this click is the only one
            // the dialog is going to get. The browser's notification permission
            // can be asked for from nowhere else — a prompt raised on page load
            // is one browsers now refuse outright.
            //
            // Named on the option rather than tested for by key here, so the
            // dialog goes on rendering the registry without knowing what is in
            // it.
            //
            // `stage` above has ALREADY painted the notices, which is what
            // covers the case where there is no prompt to answer: a browser
            // with no Notification API at all returns `undefined` here, and
            // hanging the only repaint off the promise meant the one state the
            // notice exists for was the one it never reached.
            //
            // The second paint is for the answer, which arrives whenever the
            // user gets round to it — and it is `paintNotices` and not a
            // rebuild, because by then they may be typing in a field two
            // controls down. See `paintSectionNotices`.
            if (!box.checked) return;
            const asked = opt.onEnable?.();
            if (asked && typeof asked.then === 'function') {
              asked
                .then(() => { if (dialog.open) paintNotices(); })
                .catch(() => { /* a permission prompt must not break a draft */ });
            }
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

  // The theme is the one setting this device can hold an answer to that the
  // account does not have yet, so it is read from `theme.js` rather than from
  // the cache: `settings.load()` sanitises from defaults and cannot tell "the
  // account follows the device" from "this device pressed dark and the write
  // has not been confirmed". Showing the account's view there put "Follow this
  // device" on the control while the page was painted dark — the dialog
  // disagreeing with the screen, in the one place you go to find out what the
  // theme is.
  //
  // Seeded BEFORE the baseline, so this does not by itself make the draft
  // dirty: `applyDraft` writes only keys that changed, and the theme still
  // reaches the server only if the user touches this control.
  draft.theme = currentTheme();

  baseline = JSON.stringify(draft);
  pendingReset = false;
  renderSettingsBody();
  dialog.showModal();

  refreshDeliveryNotices();
}

/**
 * Ask how the last reminder went, and say so when the answer lands.
 *
 * Not awaited by `openSettings`: the dialog opens now and the notice appears a
 * moment later. Waiting on a request first would make every open feel slow to
 * spare the one that has something to report — and offline it would never open.
 *
 * This used to call `renderSettingsBody`, and so had to be hedged twice — only
 * on a clean draft, and only when the notices had actually changed — because a
 * rebuild takes a text field's focus and content with it. `paintNotices` cannot
 * do that to anybody, so both guards are gone and a late answer now reaches
 * someone mid-edit, which is where the sentence was always most wanted.
 */
function refreshDeliveryNotices() {
  // Every section's notices, not just the one that has any today: the body is
  // rendered from the whole registry, so reading a single key here would leave
  // a second entry drawn on open and never redrawn when its answer landed.
  settings.refreshDelivery().then(() => {
    if (dialog.open) paintNotices();
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
/**
 * Settings the server's own figures are computed with.
 *
 * Named rather than inlined because the test for "did I remember to refetch?"
 * is not one a reader can run: the dashboard shows a plausible number either
 * way, just yesterday's. Anything added here that reaches `computeStats` on
 * the server belongs in this list.
 */
const SERVER_COMPUTED = ['atMostUnlogged'];

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
    // `detailCards` is deliberately NOT here. A card that comes back must not
    // come back where it was left, but which key a card pages under is
    // `ui/detail.js`'s knowledge — `score:<gran>` and `history:<gran>` are
    // built from the granularity being cleared two lines above — so the rule is
    // `forgetHiddenPositions` there, scoped to the cards actually hidden. Doing
    // it here meant clearing every card's position whenever the setting changed
    // at all, which sent a History card paged back to 2019 to today because a
    // different card was unticked.

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

    // A setting the SERVER computes with needs a refetch, not a repaint. Every
    // other setting here either changes something the browser draws itself or
    // only reaches the detail view, which refetches on 'change' — but
    // `atMostUnlogged` moves `score`, `currentStreak` and `bestStreak`, and the
    // dashboard renders those straight out of `state.habits` exactly as
    // `/overview` computed them. Without this, changing it repaints the list
    // with the old numbers and they stay wrong until a reload.
    //
    // Only when the dashboard is what is showing, and the same shape
    // `habit-dialog` uses for the same reason: 'reload' goes to the dashboard,
    // so emitting it over an open habit would navigate away from the page the
    // user is on — and that page has already refetched on the 'change' above.
    if (SERVER_COMPUTED.some((key) => key in changed) && state.openHabitId == null) {
      emit('reload');
    }
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
