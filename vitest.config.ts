import { defineConfig } from 'vitest/config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL to a dedicated PostgreSQL test database ending in _test before running API tests.');
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/(?:^|[_-])test$/i.test(databaseName)) throw new Error('API tests can reset the public schema; DATABASE_URL must target a dedicated database ending in _test.');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    env: { DATABASE_URL: databaseUrl, JWT_SECRET: 'test-only-secret', WORKER_LOG: 'silent' },
  },
});
