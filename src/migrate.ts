import { pool } from './db.js';
import { applyMigrations } from './migrations.js';
const applied = await applyMigrations(pool);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
await pool.end();
