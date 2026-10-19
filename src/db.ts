import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set. Example: postgres://USER:PASS@localhost:5432/newtonite');
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'idle database client error', error: e.message.slice(0, 200) })));
export const hooks: { afterUpdate?: () => void } = {}; // test-only fault injection point
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
