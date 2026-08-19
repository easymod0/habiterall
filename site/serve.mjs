#!/usr/bin/env node
/**
 * Preview `site/dist/` at http://localhost:4321.
 *
 *   npm run site:serve
 *
 * A server rather than opening the files directly, because every link on the
 * site is absolute (`/wiki/api/`) — under `file://` those resolve against the
 * filesystem root and every one of them 404s, which looks exactly like the
 * link check having failed to do its job.
 *
 * Development only. It is never deployed and never faces a network: GitHub
 * Pages serves the same directory in production.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

const DIST = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.env.PORT || 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

if (!existsSync(DIST)) {
  process.stderr.write('site/dist does not exist yet. Run: npm run site:build\n');
  process.exit(1);
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');

  // `normalize` after decoding and before joining, then a prefix check: a
  // request for `/../../etc/passwd` is the first thing anything pointed at a
  // directory receives, local-only or not.
  let path = join(DIST, normalize(decodeURIComponent(url.pathname)));
  if (!path.startsWith(DIST)) {
    response.writeHead(403).end('No');
    return;
  }

  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');

  if (!existsSync(path)) {
    // The same 404 page GitHub Pages will serve, so a broken link looks the
    // same here as it will in production.
    const notFound = join(DIST, '404.html');
    response.writeHead(404, { 'content-type': TYPES['.html'] });
    if (existsSync(notFound)) createReadStream(notFound).pipe(response);
    else response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(path)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`site/dist -> http://localhost:${PORT}\n`);
});
