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
  // Any line from a previous open goes now, synchronously — the async
  // refresh below removes it again before it renders, but a stacked-up
  // reply from an open that never finished must not survive to this one.
  removeBackupStatus();
  dialog.showModal();
  refreshBackupStatus();
}

// The status line's own element, held here rather than looked up by an id —
// it is built in JS and has none. `ui-modules.test.js` treats any `#id` named
// in a module's source as a lookup against `index.html`, and this element is
// deliberately not there (see the comment on `refreshBackupStatus`).
let backupStatusEl = null;

// Bumped on every call so a reply from a superseded open can tell it is one
// and decline to render — the same ticket shape `ui/detail.js`'s `openSeq`
// uses, over a single line rather than a whole page.
let backupStatusSeq = 0;

function removeBackupStatus() {
  backupStatusEl?.remove();
  backupStatusEl = null;
}

/**
 * The scheduled backup's own status (issue #75), read from
 * `GET /api/backup/status` and shown as at most one line under this
 * dialog's title — `#data-dialog` is literally "Backup and restore", so it
 * is where somebody thinking about backups already is.
 *
 * Built and inserted here in JS, never added to `index.html`: `shellFirst`
 * is stale-while-revalidate, so a client can hold this module's new JS
 * against a cached OLD `index.html` that has never heard of an element this
 * needs, which would be a null dereference on open. An in-place edit to a
 * module already in `SHELL` has no such window, which is also why this adds
 * no new file and no new export — `CACHE_VERSION` in `sw.js` stays put.
 *
 * Silent on everything except `enabled: true` with a `last` whose `state` is
 * one of the three the server can send: offline, a non-200 (a 404 from a
 * server — or edition — that predates this route, a 429 from the read
 * limiter, the service worker's synthetic 503 offline), a parse failure, or
 * an honest `enabled: false` (backups off, or the cloud edition, which
 * answers this route but has none) all say nothing rather than claiming a
 * schedule is broken because we could not ask. Follows `refreshDelivery`'s
 * precedent in `ui/settings.js`.
 */
async function refreshBackupStatus() {
  const seq = ++backupStatusSeq;
  removeBackupStatus();

  let body;
  try {
    const res = await fetch('/api/backup/status', { credentials: 'same-origin' });
    if (!res.ok) return;
    body = await res.json();
  } catch {
    // Offline, or an older server (or the cloud edition of an older build)
    // that has no such endpoint. Say nothing rather than claiming a
    // schedule is broken because we could not ask.
    return;
  }
  if (seq !== backupStatusSeq || !dialog.open) return;
  if (!body?.enabled || !body.last) return;

  const { state: runState, error, date } = body.last;
  let text;
  if (runState === 'ok') {
    text = `Scheduled backup: last ran ${date}, kept ${body.keep} files.`;
  } else if (runState === 'running') {
    // The honest reading of a row still saying 'running': that run began
    // and never finished.
    text = `Scheduled backup: the run that began ${date} has not finished.`;
  } else if (runState === 'error') {
    // The server's own words, verbatim — re-phrasing here is how this line
    // and a server log come to disagree about the same failure.
    text = `Scheduled backup: the run that began ${date} failed — ${error}`;
  } else {
    return;
  }

  const p = document.createElement('p');
  p.className = runState === 'ok' ? 'hint' : 'hint setting-problem';
  p.textContent = text;
  dialog.querySelector('h2').after(p);
  backupStatusEl = p;
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
  // A zip of Habits.csv + Checkmarks.csv, matching Loop's own export, plus
  // Categories.csv when the account has any — that third member is ours and a
  // Loop zip has no counterpart for it (#257). The route keeps its historical
  // `.csv` name; the file does not.
  $('#export-csv').addEventListener('click',
    () => download('/api/export.csv', 'habiterall-csv.zip'));
  $('#export-loop').addEventListener('click',
    () => download('/api/export-loop.db', 'Loop Habits Backup.db'));

  file.addEventListener('change', () => { run.disabled = !file.files?.length; });
  run.addEventListener('click', runImport);
}
