/**
 * The settings dialog, built from the registry in `ui/settings.js` so adding
 * an option needs no changes here.
 *
 * Owns `#settings-dialog`, its body, and the gear that opens it.
 */

import * as settings from '/shared/ui/settings.js';
import { emit, set } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';

const $ = (sel) => document.querySelector(sel);

const dialog = $('#settings-dialog');
const body = $('#settings-body');

function renderSettingsBody() {
  body.replaceChildren();
  const current = settings.load();

  for (const section of settings.sections()) {
    const group = document.createElement('section');
    group.className = 'data-section';

    const heading = document.createElement('h3');
    heading.textContent = section;
    group.append(heading);

    for (const [key, def] of Object.entries(settings.SETTINGS)) {
      if ((def.section ?? 'General') !== section) continue;
      // A control whose prerequisite is off is left out entirely rather than
      // disabled: the value is still stored, so nothing is lost by hiding it.
      if (!settings.visible(key, current)) continue;

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
        const options = def.options.some((o) => o.value === current[key])
          ? def.options
          : [{ value: current[key], label: String(current[key]) }, ...def.options];
        for (const opt of options) {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          o.selected = current[key] === opt.value;
          select.append(o);
        }
        select.addEventListener('change', () => applySetting(key, select.value));
        label.append(text, select);
      } else if (def.type === 'multi') {
        // A fieldset rather than nested labels: each destination is its own
        // checkbox, and the group needs one accessible name of its own.
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'setting-multi';
        const legend = document.createElement('legend');
        legend.textContent = def.label;
        fieldset.append(legend);

        const chosen = Array.isArray(current[key]) ? current[key] : [];
        for (const opt of def.options) {
          const row = document.createElement('label');
          row.className = 'checkbox';
          const box = document.createElement('input');
          box.id = `${controlId}-${opt.value}`;
          box.type = 'checkbox';
          box.checked = chosen.includes(opt.value);
          box.addEventListener('change', () => {
            const next = def.options
              .map((o) => o.value)
              .filter((v) => (v === opt.value ? box.checked : chosen.includes(v)));
            applySetting(key, next);
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
        input.value = current[key] ?? '';
        if (def.placeholder) input.placeholder = def.placeholder;
        // `change`, not `input`: a URL is pasted a character at a time as far
        // as `input` is concerned, and each one would be a rejected PUT.
        //
        // `save`, not `set`: whether a webhook URL is acceptable is the
        // server's call, so the field has to wait for the answer and then show
        // what was actually stored — a URL that snaps back to blank is how the
        // user learns it was refused, instead of finding out at 08:00 tomorrow.
        input.addEventListener('change', async () => {
          input.disabled = true;
          const result = await settings.save(key, input.value.trim());
          input.disabled = false;
          if (!result.ok) toast(`${def.label}: ${result.error}`);
          input.value = settings.get(key) ?? '';
        });
        label.append(text, input);
      } else {
        const box = document.createElement('input');
        box.id = controlId;
        box.type = 'checkbox';
        box.checked = !!current[key];
        box.addEventListener('change', () => applySetting(key, box.checked));
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
        }
      });
      group.append(button);
    }

    body.append(group);
  }
}

function settingHelp(textContent) {
  const help = document.createElement('p');
  help.className = 'hint setting-help';
  help.textContent = textContent;
  return help;
}

export function openSettings() {
  renderSettingsBody();
  dialog.showModal();
}

/** Persist a setting and re-render whatever it affects. */
function applySetting(key, value) {
  if (!settings.set(key, value)) return;

  // Some settings decide whether others are shown at all (enabling Discord
  // reveals its webhook field), so the body is rebuilt from the new values.
  // The body, not the dialog: showModal on an open dialog throws.
  if (dialog.open) renderSettingsBody();

  // The in-place toggles (calendar +/-, the history segmented controls) keep a
  // session override. Choosing a value in the dialog is the more deliberate
  // act, so it clears that override — otherwise the dialog would appear to do
  // nothing whenever a toggle had been touched.
  const overrides = {};
  if (key === 'calendarZoom') overrides.calZoom = null;
  if (key === 'historyGranularity') overrides.granularity = null;
  if (key === 'historyMode') overrides.historyMode = null;
  if (key === 'scoreGranularity') overrides.scoreGranularity = null;
  set(overrides);   // merges the cleared overrides and repaints the open view
}

export function init() {
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => dialog.close());
  $('#settings-reset').addEventListener('click', async () => {
    await settings.reset();
    renderSettingsBody();    // redraw the controls at their defaults
    emit('change');
  });

  // The server may store something other than what was sent — a webhook URL
  // keeps its host and loses its query string. Redraw when that happens, so
  // the dialog never shows a value the server does not hold.
  settings.onChange(() => {
    if (dialog.open) renderSettingsBody();
  });
}
