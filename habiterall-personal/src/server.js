import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { api } from './api.js';
import { db } from './db.js';
import { start as startNotifier } from './notifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();

// Imports arrive as raw bytes (JSON backup, SQLite file, or zip), so this must
// be registered before the JSON parser to keep the body unparsed.
app.use('/api/import', express.raw({ type: '*/*', limit: '64mb' }));

app.use(express.json({ limit: '1mb' }));
const SHARED_PUBLIC = join(__dirname, '..', '..', 'shared', 'public');

// This edition's own files (just the entry point) take precedence, then the
// shared UI — index.html, style.css, app.js, charts, the PWA assets. The
// whole interface lives in shared/ so a fix lands in both editions at once.
app.use(express.static(join(__dirname, '..', 'public')));
app.use(express.static(SHARED_PUBLIC));
app.use('/shared', express.static(SHARED_PUBLIC));

// Digital Asset Links, verifying the Android TWA against this origin. Express
// skips dotfiles by default, so `.well-known` needs an explicit mount or the
// app shows a URL bar with no obvious cause.
app.use('/.well-known', express.static(join(SHARED_PUBLIC, '.well-known'), {
  dotfiles: 'allow',
  setHeaders: (res) => res.type('application/json'),
}));

// A service worker may only control pages at or below its own path, so it has
// to be served from the origin root even though it lives in shared/.
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache');   // always revalidate the SW itself
  res.sendFile(join(SHARED_PUBLIC, 'sw.js'));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', api);

// Express 4 needs errors from sync route handlers funnelled through here.
app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? 'internal error' });
});

// Exported so tests can mount the real app on an ephemeral port. Importing
// this module must not start listening, or every test that touches it would
// fight over port 3000 — hence the entry-point check below.
export { app };

const isEntryPoint = process.argv[1] != null &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntryPoint) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`habiterall listening on http://localhost:${PORT}`);
  });

  // Only from the entry point, exactly like `listen`: a test that imports this
  // module for its routes must not start posting real reminders to whatever
  // webhook the developer's own database happens to hold.
  const notifier = startNotifier();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      notifier?.stop();
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}
