import { readdirSync, readFileSync } from 'node:fs';
import type pg from 'pg';
const DEFAULT_DIR = new URL('../db/migrations/', import.meta.url);
// Tables created by 001_init.sql: used to recognise a database that predates the migration runner.
const BASELINE_TABLES = ['users', 'teams', 'memberships', 'work_items', 'activity_events', 'comments', 'idempotency_records', 'outbox_jobs', 'notifications'];
/** Applies *.sql files in name order, each in its own transaction, recording them in schema_migrations.
 *  Safe to re-run. An advisory lock stops two instances migrating at once. A failing migration is rolled back completely and
 *  reported by name. A database we cannot positively identify is refused, never assumed to be migrated. Returns names applied. */
export async function applyMigrations(pool: pg.Pool, dir: URL = DEFAULT_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect(); const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(7263511)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const recorded = (await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string);
    if (recorded.length === 0) {
      const present = new Set((await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows.map((r) => r.table_name as string));
      const found = BASELINE_TABLES.filter((t) => present.has(t));
      if (found.length === BASELINE_TABLES.length) { await c.query(`INSERT INTO schema_migrations(name) VALUES('001_init.sql')`); recorded.push('001_init.sql'); } // pre-runner database with the full baseline schema
      else if (found.length > 0) throw new Error(`Refusing to migrate: the database has some application tables (${found.join(', ')}) but not all of the baseline schema (missing: ${BASELINE_TABLES.filter((t) => !present.has(t)).join(', ')}). Use an empty database.`);
    }
    const unknown = recorded.filter((n) => !files.includes(n));
    if (unknown.length) throw new Error(`Refusing to migrate: the database has migrations this code does not know about (${unknown.join(', ')}). Deploy a newer version of the application.`);
    const done = new Set(recorded);
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try { await c.query(readFileSync(new URL(f, dir), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]); await c.query('COMMIT'); applied.push(f); }
      catch (e) { await c.query('ROLLBACK'); throw new Error(`Migration ${f} failed and was rolled back: ${(e as Error).message}`, { cause: e }); }
    }
    return applied;
  } finally { await c.query('SELECT pg_advisory_unlock(7263511)').catch(() => undefined); c.release(); }
}
