import { pool } from './db.js';
export type Job = { id: number; event_type: string; payload: any; attempts: number };
export type Handler = (job: Job) => Promise<void>;
/** Throw from a handler when retrying cannot help (e.g. a malformed payload): the job goes straight to FAILED. */
export class PermanentJobError extends Error {}
// Delivery guarantee: AT LEAST ONCE. If a worker dies after the side effect but before marking the job DONE, the lease expires and
// the job is delivered again, so handlers MUST be idempotent. The default handler is (unique job_id). A database transaction cannot make
// an arbitrary external call (email, webhook) exactly-once; for those, pass the job id as the provider's idempotency key.
export const notify: Handler = async (j) => {
  await pool.query('INSERT INTO notifications(job_id,message) VALUES($1,$2) ON CONFLICT (job_id) DO NOTHING', [j.id, `${j.event_type}: ${j.payload.reference}`]);
};
/** Makes an error safe to store and log: strips credentials in URLs and key=value secrets, and truncates. */
export const redactError = (e: unknown) => String((e as Error)?.message ?? e ?? 'error').replace(/(\w+:\/\/)[^@\s/]+@/g, '$1***@').replace(/(secret|token|password|passwd|apikey|key)=\S+/gi, '$1=***').slice(0, 200);
const log = (o: object) => { if (process.env.WORKER_LOG !== 'silent') console.warn(JSON.stringify(o)); };
export type RunOptions = { maxAttempts?: number; leaseSeconds?: number; maxBackoffSeconds?: number };
/** Claims and processes at most one job. Returns false when nothing was eligible. */
export async function runOnce(handler: Handler = notify, o: RunOptions | number = {}): Promise<boolean> {
  const { maxAttempts = 5, leaseSeconds = 60, maxBackoffSeconds = 300 } = typeof o === 'number' ? { maxAttempts: o } : o;
  // A job whose worker vanished AND which already used all its attempts is finished, not retried forever.
  await pool.query(`UPDATE outbox_jobs SET status='FAILED', locked_at=NULL, last_error='worker lease expired after the maximum number of attempts', updated_at=now()
    WHERE status='PROCESSING' AND locked_at < now() - make_interval(secs => $1) AND attempts >= $2`, [leaseSeconds, maxAttempts]);
  // Eligible = due PENDING job, or a PROCESSING job whose lease expired (its worker crashed). SKIP LOCKED: two workers never take the same row.
  const { rows } = await pool.query(
    `UPDATE outbox_jobs SET status='PROCESSING', locked_at=now(), attempts=attempts+1, updated_at=now()
     WHERE id=(SELECT id FROM outbox_jobs WHERE (status='PENDING' AND available_at<=now()) OR (status='PROCESSING' AND locked_at < now() - make_interval(secs => $1))
               ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [leaseSeconds]);
  const job = rows[0] as Job | undefined; if (!job) return false;
  try {
    await handler(job);
    await pool.query(`UPDATE outbox_jobs SET status='DONE', processed_at=now(), locked_at=NULL, updated_at=now() WHERE id=$1`, [job.id]);
  } catch (e) {
    const permanent = e instanceof PermanentJobError, dead = permanent || job.attempts >= maxAttempts;
    await pool.query(
      `UPDATE outbox_jobs SET status=$2, last_error=$3, locked_at=NULL, available_at=now()+make_interval(secs => LEAST(power(2, $4::int), $5::int)), updated_at=now() WHERE id=$1`,
      [job.id, dead ? 'FAILED' : 'PENDING', redactError(e), job.attempts, maxBackoffSeconds]);
    log({ level: 'warn', msg: 'outbox job failed', jobId: job.id, eventType: job.event_type, attempt: job.attempts, permanent, willRetry: !dead, error: redactError(e) });
  }
  return true;
}
if (process.argv[1]?.endsWith('worker.ts')) {
  let stopping = false; const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const stop = () => { stopping = true; console.log(JSON.stringify({ level: 'info', msg: 'worker stopping after the current job' })); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  (async () => {
    while (!stopping) {
      try { if (!(await runOnce())) await sleep(1000); }
      catch (e) { log({ level: 'error', msg: 'worker loop error (database unavailable?)', error: redactError(e) }); await sleep(5000); }
    }
    await pool.end(); process.exit(0);
  })();
}
