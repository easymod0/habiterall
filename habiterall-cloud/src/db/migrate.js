/**
 * Migration runner.
 *
 * Runs as the ADMIN credential (owner/superuser), which is deliberately
 * separate from the credential the application uses at runtime. Applied
 * migrations are recorded so re-running is safe.
 *
 *   node src/db/migrate.js
 */

import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'migrations');

const adminUrl = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('DATABASE_URL_ADMIN (or DATABASE_URL) must be set');
  process.exit(1);
}

const appPassword = process.env.APP_DB_PASSWORD;
if (!appPassword) {
  console.error('APP_DB_PASSWORD must be set so the app role can be created');
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(dir, file), 'utf8');
    // Each migration is atomic: a failure leaves no partial schema behind.
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED ${file}: ${err.message}`);
      throw err;
    }
  }

  // Set the app role's password out of band so it is never in a .sql file.
  await client.query(
    `ALTER ROLE habiterall_app WITH PASSWORD ${literal(appPassword)}`
  );

  console.log(ran ? `${ran} migration(s) applied` : 'schema already up to date');
} finally {
  await client.end();
}

/**
 * Quote a password as a SQL literal. ALTER ROLE ... PASSWORD does not accept
 * a bind parameter, so this is escaped manually and used only here, with a
 * value that comes from the operator's own environment.
 */
function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
