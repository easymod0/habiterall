/**
 * Backup and restore. Owns `#data-dialog`, the export buttons and the import
 * form.
 *
 * Nothing in the top bar opens it any more: `openDataDialog` is called from
 * the foot of the settings dialog and from the empty state's "Import a
 * backup". Both are exports rather than a button this module binds, because
 * neither of those elements belongs to it.
 *
 * Import and export both bypass `api.js` deliberately: one sends raw bytes
 * the server sniffs, the other hands the URL to the browser so a large export
 * never passes through memory here.
 */

import { emit, state } from '/shared/ui/store.js';
import { toast } from '/shared/ui/toast.js';

const $ = (sel) => document.querySelector(sel);

const dialog = $('#data-dialog');
const file = $('#import-file');
const run = $('#import-run');
const result = $('#import-result');

export function openDataDialog() {
  result.hidden = true;
  result.classList.remove('error');
  file.value = '';
  run.disabled = true;
  dialog.showModal();
}

function download(path, fallbackName) {
  // Let the browser handle the download so large exports never hit memory.
  const a = document.createElement('a');
  a.href = path;
  a.download = fallbackName;
  document.body.append(a);
  a.click();
  a.remove();
}

async function runImport() {
  const chosen = file.files?.[0];
  if (!chosen) return;

  const mode = dialog.querySelector('input[name="import-mode"]:checked').value;

  if (mode === 'replace' &&
      !confirm('Replace mode deletes every existing habit and all history before importing. Continue?')) {
    return;
  }

  run.disabled = true;
  run.textContent = 'Importing…';
  result.hidden = true;
  result.classList.remove('error');

  try {
    const res = await fetch(`/api/import?mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: chosen, // sent as raw bytes; the server sniffs the format
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `import failed (${res.status})`);

    const parts = [
      `${body.habitsCreated} habit(s) created`,
      body.habitsMerged ? `${body.habitsMerged} merged` : '',
      `${body.entriesImported} entries imported`,
    ].filter(Boolean);

    result.textContent = parts.join(' · ');
    if (body.skipped?.length) {
      const ul = document.createElement('ul');
      for (const s of body.skipped.slice(0, 8)) {
        const li = document.createElement('li');
        li.textContent = s;
        ul.append(li);
      }
      if (body.skipped.length > 8) {
        const li = document.createElement('li');
        li.textContent = `…and ${body.skipped.length - 8} more`;
        ul.append(li);
      }
      result.append(ul);
    }
    result.hidden = false;

    // A restore replaces every habit, so the dashboard's filter goes with it —
    // otherwise the freshly imported account reads "No habits match that."
    state.query = '';
    emit('reload');
    toast('Import complete');
  } catch (e) {
    result.textContent = e.message;
    result.classList.add('error');
    result.hidden = false;
  } finally {
    run.disabled = false;
    run.textContent = 'Import';
  }
}

export function init() {
  $('#data-close').addEventListener('click', () => dialog.close());

  $('#export-json').addEventListener('click',
    () => download('/api/export?download=true', 'habiterall-backup.json'));
  // A zip of Habits.csv + Checkmarks.csv, matching Loop's own export. The route
  // keeps its historical `.csv` name; the file does not.
  $('#export-csv').addEventListener('click',
    () => download('/api/export.csv', 'habiterall-csv.zip'));
  $('#export-loop').addEventListener('click',
    () => download('/api/export-loop.db', 'Loop Habits Backup.db'));

  file.addEventListener('change', () => { run.disabled = !file.files?.length; });
  run.addEventListener('click', runImport);
}
