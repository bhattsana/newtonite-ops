// Starts the REAL API (../src) against a dedicated, freshly seeded Postgres database. No mocks on the data path.
import { spawn, spawnSync, ChildProcess } from 'node:child_process';

const PORT = 3200;
let server: ChildProcess | undefined;
const databaseUrl = process.env.WEB_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set WEB_TEST_DATABASE_URL to a dedicated PostgreSQL test database ending in _test before running web tests.');
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/(?:^|[_-])test$/i.test(databaseName)) throw new Error('Web tests seed and truncate data; WEB_TEST_DATABASE_URL must target a dedicated database ending in _test.');
const apiDatabaseUrl = process.env.DATABASE_URL;
if (apiDatabaseUrl) {
  const api = new URL(apiDatabaseUrl);
  const web = new URL(databaseUrl);
  const target = (url: URL) => `${url.hostname.toLowerCase()}:${url.searchParams.get('port') ?? (url.port || '5432')}${url.pathname}`;
  if (target(api) === target(web)) throw new Error('WEB_TEST_DATABASE_URL must use a different database from DATABASE_URL.');
}
const env = {
  ...process.env,
  PORT: String(PORT),
  JWT_SECRET: 'web-test-secret',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: databaseUrl,
};

export async function setup() {
  for (const f of ['src/migrate.ts', 'src/seed.ts']) {
    if (spawnSync(process.execPath, ['--import', 'tsx', f], { cwd: '..', env, stdio: 'ignore' }).status !== 0) {
      throw new Error(`${f} failed (is Postgres up and the DB created?)`);
    }
  }
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: '..', env, detached: process.platform !== 'win32', stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not become healthy');
}

export async function teardown() {
  if (server?.pid) {
    try {
      if (process.platform === 'win32') server.kill();
      else process.kill(-server.pid);
    } catch { /* already gone */ }
  }
}
