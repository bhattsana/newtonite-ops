import express, { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tx, hooks } from './db.js';
import { HttpError, Role, TRANSITIONS, atLeast } from './domain.js';
import type { DashboardSummary } from '../shared/types.js';

// Fail fast: never run production with a missing/weak signing secret. Dev/test fall back to a clearly fake one.
if (process.env.NODE_ENV === 'production' && (process.env.JWT_SECRET?.length ?? 0) < 32) throw new Error('JWT_SECRET must be set (>= 32 chars) in production');
const SECRET = process.env.JWT_SECRET ?? 'dev-only-secret';
const DUMMY_HASH = await argon2.hash('timing-equalizer'); // verified when the email is unknown so response time doesn't reveal which emails exist
type Req = Request & { user?: { id: number; name: string }; jti?: string; tokenExp?: number };
const MAX_LOGIN_FAILURES = Number(process.env.LOGIN_MAX_FAILURES ?? 10); // per email+IP per 15-minute window
const p = <T,>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) {
    const fields = r.error.flatten().fieldErrors as Record<string, string[]>;
    for (const i of r.error.issues) if (i.code === 'unrecognized_keys') for (const k of i.keys) fields[k] = ['Unknown field']; // never silently ignore e.g. status/actorId
    throw new HttpError(422, 'VALIDATION_ERROR', 'Invalid request', fields);
  }
  return r.data;
};
const itemId = (req: Request) => p(z.coerce.number().int().positive(), req.params.itemId);

async function auth(req: Req, _res: Response, next: NextFunction) {
  try {
    const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const p = jwt.verify(t, SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!p.sub || !p.jti) throw new Error('token without subject/jti');
    // One query: the user must still exist AND this exact token must not have been revoked by logout.
    const { rows } = await pool.query('SELECT u.id,u.name FROM users u WHERE u.id=$1 AND NOT EXISTS (SELECT 1 FROM revoked_tokens r WHERE r.jti=$2)', [Number(p.sub), p.jti]);
    if (!rows[0]) throw new Error('unknown user or revoked token');
    req.user = rows[0]; req.jti = p.jti; req.tokenExp = p.exp; next();
  } catch { next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required')); }
}

// Returns the item (locked-free read) and caller's role in its team; 404 for non-members so nothing leaks.
async function access(c: PoolClient, userId: number, id: number, min: Role = 'VIEWER') {
  const { rows } = await c.query(
    `SELECT w.*, m.role AS my_role FROM work_items w JOIN memberships m ON m.team_id=w.team_id AND m.user_id=$2 WHERE w.id=$1`, [id, userId]);
  const row = rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Work item not found');
  if (!atLeast(row.my_role, min)) throw new HttpError(403, 'FORBIDDEN', `Requires ${min} role`);
  return row;
}
const log = (c: PoolClient, id: number, actor: number, type: string, prev: unknown, next: unknown, meta?: unknown) =>
  c.query('INSERT INTO activity_events(work_item_id,actor_id,event_type,previous_value,new_value,metadata) VALUES($1,$2,$3,$4,$5,$6)',
    [id, actor, type, JSON.stringify(prev ?? null), JSON.stringify(next ?? null), meta ? JSON.stringify(meta) : null]);
const outbox = (c: PoolClient, type: string, payload: unknown) =>
  c.query('INSERT INTO outbox_jobs(event_type,payload) VALUES($1,$2)', [type, JSON.stringify(payload)]);
const stale = () => new HttpError(409, 'STALE_VERSION', 'This item was changed by someone else. Reload and retry.');
const pub = ({ my_role, ...i }: any) => i;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const tp = process.env.TRUST_PROXY; if (tp) app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp); // only set behind a proxy you control, or req.ip is spoofable
  app.use((_req, res, next) => { // JSON-only API: lock down everything a browser could otherwise do with a response
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"); res.setHeader('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  const configuredOrigins = process.env.CORS_ORIGINS;
  const origins = (configuredOrigins ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && (!configuredOrigins?.trim() || origins.length === 0)) {
    throw new Error('CORS_ORIGINS must contain the exact HTTPS frontend origin(s) in production');
  }
  if (process.env.NODE_ENV === 'production' && origins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol !== 'https:' || parsed.origin !== origin;
    } catch {
      return true;
    }
  })) {
    throw new Error('CORS_ORIGINS must contain only exact HTTPS origins in production');
  }
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && origins.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.get('/health', async (_q, r) => {
    await pool.query('SELECT 1');
    r.json({ ok: true });
  });
  const api = express.Router();
  app.use('/api/v1', api);

  api.post('/auth/login', async (req, res) => {
    const b = p(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const key = `${b.email.toLowerCase()}|${req.ip}`; // per email AND IP, so an attacker cannot lock a victim out from another address
    const lim = await pool.query(`SELECT failures, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + interval '15 minutes' - now()))))::int AS retry FROM login_attempts WHERE key=$1 AND window_start > now() - interval '15 minutes'`, [key]);
    if (lim.rows[0] && lim.rows[0].failures >= MAX_LOGIN_FAILURES) { res.setHeader('Retry-After', String(lim.rows[0].retry)); throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again later.'); }
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [b.email.toLowerCase()]);
    const u = rows[0];
    const ok = await argon2.verify(u?.password_hash ?? DUMMY_HASH, b.password);
    if (!u || !ok) { // unknown emails are counted too, so lockout behaviour does not reveal which accounts exist
      await pool.query(`INSERT INTO login_attempts(key,failures,window_start) VALUES($1,1,now()) ON CONFLICT (key) DO UPDATE SET
        failures = CASE WHEN login_attempts.window_start < now() - interval '15 minutes' THEN 1 ELSE login_attempts.failures + 1 END,
        window_start = CASE WHEN login_attempts.window_start < now() - interval '15 minutes' THEN now() ELSE login_attempts.window_start END`, [key]);
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    await pool.query('DELETE FROM login_attempts WHERE key=$1', [key]);
    res.json({ token: jwt.sign({ sub: String(u.id) }, SECRET, { algorithm: 'HS256', expiresIn: '15m', jwtid: randomUUID() }), user: { id: u.id, name: u.name, email: u.email } });
  });
  api.get('/auth/me', auth, async (req: Req, res) => {
    const { rows } = await pool.query('SELECT team_id, role FROM memberships WHERE user_id=$1', [req.user!.id]);
    res.json({ user: req.user, memberships: rows });
  });

  api.get('/items', auth, async (req: Req, res) => {
    const q = p(z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED']).optional(),
      teamId: z.coerce.number().int().optional(), assigneeId: z.coerce.number().int().optional(),
      q: z.string().max(100).optional(), overdue: z.enum(['true', 'false']).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(), type: z.string().max(40).optional(),
      unassigned: z.enum(['true', 'false']).optional(), active: z.enum(['true', 'false']).optional(), approvable: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.coerce.number().int().optional(),
    }), req.query);
    const args: unknown[] = [req.user!.id]; const w: string[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); w.push(sql.replaceAll('?', `$${args.length}`)); };
    if (q.status) add('w.status=?', q.status);
    if (q.teamId) add('w.team_id=?', q.teamId);
    if (q.assigneeId) add('w.assignee_id=?', q.assigneeId);
    if (q.cursor) add('w.id<?', q.cursor);
    if (q.priority) add('w.priority=?', q.priority);
    if (q.type) add('w.type=?', q.type);
    if (q.unassigned === 'true') w.push('w.assignee_id IS NULL');
    if (q.active === 'true') w.push("w.status NOT IN ('RESOLVED','CLOSED')");
    if (q.approvable === 'true') w.push("w.status='AWAITING_APPROVAL' AND m.role IN ('LEAD','ADMIN')");
    if (q.overdue === 'true') w.push("w.due_at < now() AND w.status NOT IN ('RESOLVED','CLOSED')");
    if (q.q) add('(w.title ILIKE ? OR w.description ILIKE ? OR w.reference ILIKE ?)', `%${q.q.replace(/[%_\\]/g, '')}%`);
    const where = w.length ? 'AND ' + w.join(' AND ') : '';
    args.push(q.limit + 1);
    const { rows } = await pool.query(
      `SELECT w.*, u.name AS assignee_name FROM work_items w JOIN memberships m ON m.team_id=w.team_id AND m.user_id=$1 LEFT JOIN users u ON u.id=w.assignee_id WHERE true ${where} ORDER BY w.id DESC LIMIT $${args.length}`, args);
    const more = rows.length > q.limit; const data = rows.slice(0, q.limit);
    res.json({ data, nextCursor: more ? data[data.length - 1].id : null });
  });

  api.post('/items', auth, async (req: Req, res) => {
    const b = p(z.object({
      title: z.string().trim().min(1).max(200), description: z.string().max(10000).default(''),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'), type: z.string().max(40).default('TASK'),
      teamId: z.number().int(), dueAt: z.string().datetime().nullable().optional(),
    }), req.body);
    const key = req.header('Idempotency-Key');
    const hash = createHash('sha256').update(JSON.stringify(b)).digest('hex');
    const out = await tx(async (c) => {
      const m = await c.query('SELECT role FROM memberships WHERE user_id=$1 AND team_id=$2', [req.user!.id, b.teamId]);
      if (!m.rows[0]) throw new HttpError(403, 'FORBIDDEN', 'Not a member of that team');
      if (!atLeast(m.rows[0].role, 'MEMBER')) throw new HttpError(403, 'FORBIDDEN', 'Requires MEMBER role');
      if (key) {
        // Retention: a record older than its expires_at (24h) is treated as absent, so the key can be reused. No background purge.
        await c.query(`DELETE FROM idempotency_records WHERE key=$1 AND actor_id=$2 AND scope='create_item' AND expires_at < now()`, [key, req.user!.id]);
        const ins = await c.query(
          `INSERT INTO idempotency_records(key,actor_id,scope,request_hash) VALUES($1,$2,'create_item',$3) ON CONFLICT DO NOTHING RETURNING id`, [key, req.user!.id, hash]);
        if (!ins.rows[0]) { // concurrent duplicate blocks on the unique index until the first commits
          const { rows } = await c.query(`SELECT request_hash,response_status,response_body FROM idempotency_records WHERE key=$1 AND actor_id=$2 AND scope='create_item'`, [key, req.user!.id]);
          if (rows[0].request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different payload');
          return { status: rows[0].response_status, body: rows[0].response_body, replay: true };
        }
      }
      const { rows } = await c.query(
        `INSERT INTO work_items(title,description,priority,type,team_id,created_by_id,due_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.title, b.description, b.priority, b.type, b.teamId, req.user!.id, b.dueAt ?? null]);
      hooks.afterUpdate?.(); // test-only failure injection: after the business write, before activity/outbox/commit
      await log(c, rows[0].id, req.user!.id, 'CREATED', null, { title: b.title, priority: b.priority });
      await outbox(c, 'ITEM_CREATED', { itemId: rows[0].id, reference: rows[0].reference });
      const body = rows[0];
      if (key) await c.query(`UPDATE idempotency_records SET response_status=201,response_body=$4 WHERE key=$1 AND actor_id=$2 AND scope=$3`, [key, req.user!.id, 'create_item', JSON.stringify(body)]);
      return { status: 201, body, replay: false };
    });
    if (out.replay) res.setHeader('Idempotent-Replay', 'true');
    res.status(out.status).json(out.body);
  });

  api.get('/items/:itemId', auth, async (req: Req, res) => res.json(pub(await access(pool as any, req.user!.id, itemId(req)))));

  api.patch('/items/:itemId', auth, async (req: Req, res) => {
    const b = p(z.object({
      expectedVersion: z.number().int(), title: z.string().trim().min(1).max(200).optional(), description: z.string().max(10000).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(), dueAt: z.string().datetime().nullable().optional(), assigneeId: z.number().int().nullable().optional(),
    }).strict(), req.body);
    const out = await tx(async (c) => {
      const cur = await access(c, req.user!.id, itemId(req), 'MEMBER');
      if (b.assigneeId !== undefined && b.assigneeId !== cur.assignee_id) {
        if (!atLeast(cur.my_role, 'LEAD')) throw new HttpError(403, 'FORBIDDEN', 'Only a Lead can reassign');
        if (b.assigneeId !== null) {
          const m = await c.query('SELECT role FROM memberships WHERE user_id=$1 AND team_id=$2', [b.assigneeId, cur.team_id]);
          if (!m.rows[0] || !atLeast(m.rows[0].role, 'MEMBER')) throw new HttpError(422, 'INVALID_ASSIGNEE', 'Assignee must be a member of the item team');
        }
      }
      const changes: [string, unknown, unknown][] = [];
      for (const [col, k] of [['title', 'title'], ['description', 'description'], ['priority', 'priority'], ['due_at', 'dueAt'], ['assignee_id', 'assigneeId']] as const) {
        const nv = (b as any)[k]; if (nv === undefined) continue;
        const ov = cur[col] instanceof Date ? cur[col].toISOString() : cur[col];
        if (JSON.stringify(ov) !== JSON.stringify(nv)) changes.push([col, ov, nv]);
      }
      if (changes.length === 0) { // nothing meaningful to write: no version bump, no event, no outbox job
        if (cur.version !== b.expectedVersion) throw stale(); // still tell a stale client its view is out of date
        return pub(cur);
      }
      const set = changes.map(([col], i) => `${col}=$${i + 3}`).join(',');
      // Atomic compare-and-set on version: zero rows means someone else got there first.
      const { rows } = await c.query(
        `UPDATE work_items SET ${set ? set + ',' : ''}version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING *`,
        [cur.id, b.expectedVersion, ...changes.map((x) => x[2])]);
      if (!rows[0]) throw stale();
      hooks.afterUpdate?.();
      for (const [col, ov, nv] of changes) await log(c, cur.id, req.user!.id, `${col.toUpperCase()}_CHANGED`, ov, nv);
      return rows[0];
    });
    res.json(out);
  });

  api.post('/items/:itemId/claim', auth, async (req: Req, res) => {
    const out = await tx(async (c) => {
      const cur = await access(c, req.user!.id, itemId(req), 'MEMBER');
      // Single conditional UPDATE: only one concurrent claimant can match `assignee_id IS NULL`.
      const { rows } = await c.query(
        `UPDATE work_items SET assignee_id=$2, status=CASE WHEN status='OPEN' THEN 'IN_PROGRESS'::item_status ELSE status END, version=version+1, updated_at=now()
         WHERE id=$1 AND assignee_id IS NULL AND status IN ('OPEN','IN_PROGRESS') RETURNING *`, [cur.id, req.user!.id]);
      if (!rows[0]) throw new HttpError(409, 'ALREADY_CLAIMED', 'This item has already been claimed or cannot be claimed');
      hooks.afterUpdate?.();
      await log(c, cur.id, req.user!.id, 'CLAIMED', { assigneeId: null }, { assigneeId: req.user!.id });
      return rows[0];
    });
    res.json(out);
  });

  api.post('/items/:itemId/transition', auth, async (req: Req, res) => {
    const b = p(z.object({ to: z.enum(['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED']), expectedVersion: z.number().int(), note: z.string().max(1000).optional() }), req.body);
    const out = await tx(async (c) => {
      const cur = await access(c, req.user!.id, itemId(req), 'MEMBER');
      const min = TRANSITIONS[cur.status as keyof typeof TRANSITIONS][b.to];
      if (!min) throw new HttpError(409, 'INVALID_TRANSITION', `Cannot move from ${cur.status} to ${b.to}`);
      if (!atLeast(cur.my_role, min)) throw new HttpError(403, 'FORBIDDEN', `Transition to ${b.to} requires ${min} role`);
      const { rows } = await c.query(
        `UPDATE work_items SET status=$3::item_status, version=version+1, updated_at=now(), resolved_at=CASE WHEN $3::item_status='RESOLVED' THEN now() ELSE resolved_at END
         WHERE id=$1 AND version=$2 RETURNING *`, [cur.id, b.expectedVersion, b.to]);
      if (!rows[0]) throw stale();
      hooks.afterUpdate?.();
      const approval = cur.status === 'AWAITING_APPROVAL';
      await log(c, cur.id, req.user!.id, approval ? (b.to === 'RESOLVED' ? 'APPROVED' : 'APPROVAL_REJECTED') : 'STATUS_CHANGED', cur.status, b.to, b.note ? { note: b.note } : undefined);
      if (['AWAITING_APPROVAL', 'RESOLVED'].includes(b.to)) await outbox(c, 'ITEM_' + b.to, { itemId: cur.id, reference: cur.reference });
      return rows[0];
    });
    res.json(out);
  });

  api.get('/items/:itemId/activity', auth, async (req: Req, res) => {
    const id = itemId(req); await access(pool as any, req.user!.id, id);
    const { rows } = await pool.query('SELECT a.*, u.name AS actor_name FROM activity_events a JOIN users u ON u.id=a.actor_id WHERE work_item_id=$1 ORDER BY a.id LIMIT 200', [id]);
    res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id) })) }); // activity_events.id is a bigserial: pg returns bigint as a string, the contract says number
  });
  api.get('/items/:itemId/comments', auth, async (req: Req, res) => {
    const id = itemId(req); await access(pool as any, req.user!.id, id);
    const { rows } = await pool.query('SELECT * FROM comments WHERE work_item_id=$1 ORDER BY id LIMIT 200', [id]);
    res.json({ data: rows });
  });
  api.post('/items/:itemId/comments', auth, async (req: Req, res) => {
    const { body } = p(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
    const out = await tx(async (c) => {
      const cur = await access(c, req.user!.id, itemId(req), 'MEMBER');
      const { rows } = await c.query('INSERT INTO comments(work_item_id,author_id,body) VALUES($1,$2,$3) RETURNING *', [cur.id, req.user!.id, body]);
      hooks.afterUpdate?.();
      await log(c, cur.id, req.user!.id, 'COMMENTED', null, { commentId: rows[0].id });
      return rows[0];
    });
    res.status(201).json(out);
  });

  api.post('/auth/logout', auth, async (req: Req, res) => { // revoke THIS token server-side until it would have expired anyway
    await pool.query('INSERT INTO revoked_tokens(jti,expires_at) VALUES($1, to_timestamp($2)) ON CONFLICT DO NOTHING', [req.jti, req.tokenExp]);
    await pool.query('DELETE FROM revoked_tokens WHERE expires_at < now()');
    res.sendStatus(204);
  });
  api.get('/teams', auth, async (req: Req, res) => {
    const { rows } = await pool.query('SELECT t.id,t.name,t.slug,t.description,m.role FROM teams t JOIN memberships m ON m.team_id=t.id WHERE m.user_id=$1 ORDER BY t.name', [req.user!.id]);
    res.json({ data: rows });
  });
  api.get('/teams/:teamId/members', auth, async (req: Req, res) => {
    const tid = p(z.coerce.number().int().positive(), req.params.teamId);
    const mine = await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND team_id=$2', [req.user!.id, tid]);
    if (!mine.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Team not found');
    const { rows } = await pool.query('SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 ORDER BY u.name', [tid]);
    res.json({ data: rows });
  });
  api.get('/dashboard/summary', auth, async (req: Req, res) => {
    const { rows } = await pool.query(`SELECT
      count(*) FILTER (WHERE w.assignee_id=$1 AND w.status NOT IN ('RESOLVED','CLOSED')) AS assigned_to_me,
      count(*) FILTER (WHERE w.assignee_id IS NULL AND w.priority='URGENT' AND w.status NOT IN ('RESOLVED','CLOSED')) AS unassigned_urgent,
      count(*) FILTER (WHERE w.status='AWAITING_APPROVAL' AND m.role IN ('LEAD','ADMIN')) AS awaiting_my_approval,
      count(*) FILTER (WHERE w.due_at < now() AND w.status NOT IN ('RESOLVED','CLOSED')) AS overdue
      FROM work_items w JOIN memberships m ON m.team_id=w.team_id AND m.user_id=$1`, [req.user!.id]);
    const r = rows[0]; const body: DashboardSummary = { assignedToMe: +r.assigned_to_me, unassignedUrgent: +r.unassigned_urgent, awaitingMyApproval: +r.awaiting_my_approval, overdue: +r.overdue }; res.json(body);
  });

  app.use((e: any, req: Request, res: Response, _n: NextFunction) => {
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    if (e?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
    if (e instanceof HttpError) return res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
    console.error(e); res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
  });
  return app;
}
