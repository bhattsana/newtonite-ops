import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { pool, hooks } from '../src/db.js';
import { createApp } from '../src/app.js';
import { runOnce, notify, redactError, PermanentJobError } from '../src/worker.js';
import { TRANSITIONS, type Status } from '../src/domain.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { applyMigrations } from '../src/migrations.js';
import { ITEM_KEYS, ACTIVITY_KEYS, COMMENT_KEYS, TEAM_KEYS, MEMBER_KEYS, ME_KEYS, SUMMARY_KEYS } from '../shared/types.js';

const app = createApp();
const ids: Record<string, number> = {}; const tok: Record<string, string> = {}; let teamA: number, teamB: number;

async function reset() {
  if (!/test/i.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error('Refusing to wipe a database whose name does not contain "test"');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyMigrations(pool);
  const hash = await argon2.hash('demo-local-only');
  teamA = (await pool.query(`INSERT INTO teams(name,slug) VALUES('Alpha','alpha') RETURNING id`)).rows[0].id;
  teamB = (await pool.query(`INSERT INTO teams(name,slug) VALUES('Beta','beta') RETURNING id`)).rows[0].id;
  const users: [string, number, string][] = [['viewer', teamA, 'VIEWER'], ['member', teamA, 'MEMBER'], ['member2', teamA, 'MEMBER'], ['lead', teamA, 'LEAD'], ['outsider', teamB, 'MEMBER']];
  for (const [n, t, r] of users) {
    ids[n] = (await pool.query(`INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id`, [n, `${n}@demo.test`, hash])).rows[0].id;
    await pool.query('INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)', [ids[n], t, r]);
    tok[n] = (await request(app).post('/api/v1/auth/login').send({ email: `${n}@demo.test`, password: 'demo-local-only' })).body.token;
  }
}
const as = (u: string) => ({ Authorization: `Bearer ${tok[u]}` });
const mk = async (u = 'member', extra = {}) => (await request(app).post('/api/v1/items').set(as(u)).send({ title: 'Disk alert', teamId: teamA, ...extra })).body;
const count = async (t: string) => Number((await pool.query(`SELECT count(*) FROM ${t}`)).rows[0].count);

beforeAll(reset); beforeEach(() => { hooks.afterUpdate = undefined; });
afterAll(() => pool.end());

describe('auth', () => {
  it('rejects invalid credentials', async () => {
    const r = await request(app).post('/api/v1/auth/login').send({ email: 'member@demo.test', password: 'wrong' });
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });
  it('requires a token', async () => { expect((await request(app).get('/api/v1/items')).status).toBe(401); });
});

describe('authorization', () => {
  it('viewer cannot mutate', async () => {
    const it1 = await mk();
    expect((await request(app).patch(`/api/v1/items/${it1.id}`).set(as('viewer')).send({ expectedVersion: 1, title: 'x' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/items/${it1.id}/claim`).set(as('viewer'))).status).toBe(403);
  });
  it('outsider gets 404 on detail, activity, comments, claim and not in list', async () => {
    const it1 = await mk();
    for (const [m, path] of [['get', ''], ['get', '/activity'], ['get', '/comments'], ['post', '/claim']] as const)
      expect((await (request(app) as any)[m](`/api/v1/items/${it1.id}${path}`).set(as('outsider'))).status).toBe(404);
    expect((await request(app).get('/api/v1/items').set(as('outsider'))).body.data).toHaveLength(0);
  });
  it('cannot create in a team you are not in', async () => {
    expect((await request(app).post('/api/v1/items').set(as('outsider')).send({ title: 't', teamId: teamA })).status).toBe(403);
  });
});

describe('concurrency', () => {
  it('exactly one concurrent claim wins', async () => {
    const it1 = await mk();
    const rs = await Promise.all(['member', 'member2', 'lead'].flatMap((u) => [1, 2, 3].map(() => request(app).post(`/api/v1/items/${it1.id}/claim`).set(as(u)))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409 && r.body.error.code === 'ALREADY_CLAIMED')).toHaveLength(8);
    expect(Number((await pool.query(`SELECT count(*) FROM activity_events WHERE work_item_id=$1 AND event_type='CLAIMED'`, [it1.id])).rows[0].count)).toBe(1);
  });
  it('stale update conflicts and does not overwrite', async () => {
    const it1 = await mk();
    expect((await request(app).patch(`/api/v1/items/${it1.id}`).set(as('member')).send({ expectedVersion: 1, title: 'New' })).body.version).toBe(2);
    const r = await request(app).patch(`/api/v1/items/${it1.id}`).set(as('member2')).send({ expectedVersion: 1, title: 'Lost' });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('STALE_VERSION');
    expect((await request(app).get(`/api/v1/items/${it1.id}`).set(as('member'))).body.title).toBe('New');
  });
});

describe('idempotency', () => {
  const send = (key: string, title: string) => request(app).post('/api/v1/items').set(as('member')).set('Idempotency-Key', key).send({ title, teamId: teamA });
  it('same key + payload returns the original, even when simultaneous', async () => {
    const before = await count('work_items');
    const rs = await Promise.all([1, 2, 3, 4].map(() => send('k1', 'Once')));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await count('work_items')).toBe(before + 1);
  });
  it('same key + different payload is rejected', async () => {
    await send('k2', 'A'); const r = await send('k2', 'B');
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('workflow', () => {
  const tr = (u: string, id: number, to: string, v: number) => request(app).post(`/api/v1/items/${id}/transition`).set(as(u)).send({ to, expectedVersion: v });
  it('rejects invalid jumps', async () => {
    const it1 = await mk(); const r = await tr('lead', it1.id, 'RESOLVED', 1);
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('INVALID_TRANSITION');
  });
  it('only a Lead can approve; approval is logged with actor', async () => {
    const it1 = await mk();
    let r = await tr('member', it1.id, 'IN_PROGRESS', 1); r = await tr('member', it1.id, 'AWAITING_APPROVAL', r.body.version);
    const v = r.body.version;
    expect((await tr('member', it1.id, 'RESOLVED', v)).status).toBe(403);
    const ok = await tr('lead', it1.id, 'RESOLVED', v); expect(ok.status).toBe(200);
    const ev = (await pool.query(`SELECT actor_id FROM activity_events WHERE work_item_id=$1 AND event_type='APPROVED'`, [it1.id])).rows;
    expect(ev).toEqual([{ actor_id: ids.lead }]);
  });
  it('update and activity commit together; failure rolls both back', async () => {
    const it1 = await mk();
    const ok = await request(app).patch(`/api/v1/items/${it1.id}`).set(as('member')).send({ expectedVersion: 1, priority: 'URGENT' });
    expect(ok.status).toBe(200);
    expect((await pool.query(`SELECT count(*) FROM activity_events WHERE work_item_id=$1 AND event_type='PRIORITY_CHANGED'`, [it1.id])).rows[0].count).toBe('1');
    hooks.afterUpdate = () => { throw new Error('boom'); };
    const bad = await request(app).patch(`/api/v1/items/${it1.id}`).set(as('member')).send({ expectedVersion: 2, priority: 'LOW' });
    expect(bad.status).toBe(500);
    const row = (await pool.query('SELECT priority,version FROM work_items WHERE id=$1', [it1.id])).rows[0];
    expect(row).toEqual({ priority: 'URGENT', version: 2 });
    expect((await pool.query(`SELECT count(*) FROM activity_events WHERE work_item_id=$1 AND event_type='PRIORITY_CHANGED'`, [it1.id])).rows[0].count).toBe('1');
  });
});

describe('list', () => {
  it('filters, searches and paginates with a cursor', async () => {
    for (let i = 0; i < 5; i++) await mk('member', { title: `Pager ${i}`, priority: 'LOW' });
    const p1 = (await request(app).get('/api/v1/items?q=pager&limit=2').set(as('member'))).body;
    expect(p1.data).toHaveLength(2); expect(p1.nextCursor).not.toBeNull();
    const p2 = (await request(app).get(`/api/v1/items?q=pager&limit=2&cursor=${p1.nextCursor}`).set(as('member'))).body;
    expect(p2.data.every((x: any) => x.id < p1.nextCursor && /pager/i.test(x.title))).toBe(true);
    expect((await request(app).get('/api/v1/items?limit=500').set(as('member'))).status).toBe(422);
    expect((await request(app).get('/api/v1/items?status=CLOSED').set(as('member'))).body.data).toHaveLength(0);
  });
});

describe('outbox', () => {
  it('retries after a transient failure and does not duplicate the side effect', async () => {
    await pool.query(`TRUNCATE outbox_jobs, notifications RESTART IDENTITY CASCADE`);
    await mk(); let calls = 0;
    const flaky = async (j: any) => { calls++; if (calls === 1) throw new Error('transient'); await pool.query('INSERT INTO notifications(job_id,message) VALUES($1,$2) ON CONFLICT (job_id) DO NOTHING', [j.id, 'x']); };
    await runOnce(flaky);
    let j = (await pool.query('SELECT status,attempts FROM outbox_jobs')).rows[0]; expect(j).toEqual({ status: 'PENDING', attempts: 1 });
    expect(await runOnce(flaky)).toBe(false); // backoff not elapsed yet
    await pool.query(`UPDATE outbox_jobs SET available_at=now()`);
    await runOnce(flaky); await runOnce(flaky);
    j = (await pool.query('SELECT status,attempts FROM outbox_jobs')).rows[0]; expect(j).toEqual({ status: 'DONE', attempts: 2 });
    expect(await count('notifications')).toBe(1);
  });
  it('gives up after max attempts', async () => {
    await pool.query(`TRUNCATE outbox_jobs, notifications RESTART IDENTITY CASCADE`); await mk();
    for (let i = 0; i < 3; i++) { await pool.query(`UPDATE outbox_jobs SET available_at=now()`); await runOnce(async () => { throw new Error('nope'); }, 3); }
    expect((await pool.query('SELECT status,attempts FROM outbox_jobs')).rows[0]).toEqual({ status: 'FAILED', attempts: 3 });
  });
  it('two workers never take the same job', async () => {
    await pool.query(`TRUNCATE outbox_jobs, notifications RESTART IDENTITY CASCADE`); await mk(); let n = 0;
    await Promise.all([runOnce(async () => { n++; }), runOnce(async () => { n++; })]);
    expect(n).toBe(1);
  });
});

describe('teams, dashboard, reassignment', () => {
  it('lists teams/members only for members; dashboard counts are scoped', async () => {
    expect((await request(app).get(`/api/v1/teams/${teamA}/members`).set(as('outsider'))).status).toBe(404);
    expect((await request(app).get(`/api/v1/teams/${teamA}/members`).set(as('viewer'))).body.data.length).toBe(4);
    await mk('member', { title: 'Urgent unassigned', priority: 'URGENT' });
    const a = (await request(app).get('/api/v1/dashboard/summary').set(as('member'))).body;
    const o = (await request(app).get('/api/v1/dashboard/summary').set(as('outsider'))).body;
    expect(a.unassignedUrgent).toBeGreaterThan(0); expect(o).toEqual({ assignedToMe: 0, unassignedUrgent: 0, awaitingMyApproval: 0, overdue: 0 });
  });
  it('only a Lead can reassign, and only to a team member', async () => {
    const it1 = await mk(); const url = `/api/v1/items/${it1.id}`;
    expect((await request(app).patch(url).set(as('member')).send({ expectedVersion: 1, assigneeId: ids.member2 })).status).toBe(403);
    expect((await request(app).patch(url).set(as('lead')).send({ expectedVersion: 1, assigneeId: ids.outsider })).status).toBe(422);
    expect((await request(app).patch(url).set(as('lead')).send({ expectedVersion: 1, assigneeId: ids.member2 })).body.assignee_id).toBe(ids.member2);
  });
});

describe('hardening', () => {
  it('malformed JSON is a 400, not a 500', async () => {
    const r = await request(app).post('/api/v1/items').set(as('member')).set('content-type', 'application/json').send('{bad');
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('BAD_JSON');
  });
  it('rejects a token signed with another secret or algorithm', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    expect((await request(app).get('/api/v1/items').set('Authorization', `Bearer ${jwt.sign({ sub: String(ids.member) }, 'wrong-secret')}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/items').set('Authorization', `Bearer ${jwt.sign({ sub: String(ids.member) }, 'test-only-secret', { algorithm: 'HS512' })}`)).status).toBe(401);
  });
});

describe('dashboard-aligned filters', () => {
  it('assigneeId+active, unassigned+priority and approvable return exactly what the summary counts', async () => {
    const urgent = await mk('member', { title: 'Filter urgent', priority: 'URGENT' });
    const mine = await mk('member', { title: 'Filter mine' }); await request(app).post(`/api/v1/items/${mine.id}/claim`).set(as('member'));
    const sum = (await request(app).get('/api/v1/dashboard/summary').set(as('lead'))).body;
    const un = (await request(app).get('/api/v1/items?unassigned=true&priority=URGENT&active=true&limit=100').set(as('lead'))).body.data;
    expect(un.length).toBe(sum.unassignedUrgent); expect(un.some((i: any) => i.id === urgent.id)).toBe(true);
    const sm = (await request(app).get('/api/v1/dashboard/summary').set(as('member'))).body;
    const m = (await request(app).get(`/api/v1/items?assigneeId=${ids.member}&active=true&limit=100`).set(as('member'))).body.data;
    expect(m.length).toBe(sm.assignedToMe);
    for (const u of ['member', 'lead', 'viewer']) {
      const s = (await request(app).get('/api/v1/dashboard/summary').set(as(u))).body;
      expect((await request(app).get('/api/v1/items?approvable=true&limit=100').set(as(u))).body.data.length).toBe(s.awaitingMyApproval);
    }
    expect((await request(app).get('/api/v1/items?type=INCIDENT&limit=100').set(as('member'))).body.data.every((i: any) => i.type === 'INCIDENT')).toBe(true);
    expect((await request(app).get('/api/v1/items?priority=BOGUS').set(as('member'))).status).toBe(422);
  });
});

describe('API <-> frontend contract (shared/types.ts)', () => {
  it('every response carries exactly the item fields, and every field the frontend reads from the other endpoints', async () => {
    const it1 = await mk(); await request(app).post(`/api/v1/items/${it1.id}/comments`).set(as('member')).send({ body: 'contract' });
    const get = async (p: string) => (await request(app).get(`/api/v1${p}`).set(as('member'))).body;
    expect(Object.keys(await get(`/items/${it1.id}`)).sort()).toEqual([...ITEM_KEYS].sort());
    expect(Object.keys((await get('/items?limit=1')).data[0]).sort()).toEqual([...ITEM_KEYS, 'assignee_name'].sort());
    expect(Object.keys(await request(app).post('/api/v1/items').set(as('member')).send({ title: 'k', teamId: teamA }).then((r) => r.body)).sort()).toEqual([...ITEM_KEYS].sort());
    const has = (obj: object, keys: readonly string[]) => keys.forEach((k) => expect(obj).toHaveProperty(k));
    has((await get(`/items/${it1.id}/activity`)).data[0], ACTIVITY_KEYS); has((await get(`/items/${it1.id}/comments`)).data[0], COMMENT_KEYS);
    has((await get('/teams')).data[0], TEAM_KEYS); has((await get(`/teams/${teamA}/members`)).data[0], MEMBER_KEYS);
    has(await get('/auth/me'), ME_KEYS); has(await get('/dashboard/summary'), SUMMARY_KEYS);
    // value TYPES, not just names (a bigint column once leaked out as a string, so "100" < "99" when sorted client-side)
    const act0 = (await get(`/items/${it1.id}/activity`)).data[0], itemBody = await get(`/items/${it1.id}`);
    expect([typeof act0.id, typeof act0.event_type, typeof act0.actor_name, typeof act0.created_at]).toEqual(['number', 'string', 'string', 'string']);
    expect([typeof itemBody.id, typeof itemBody.version, typeof itemBody.team_id, typeof itemBody.created_by_id, typeof itemBody.title]).toEqual(['number', 'number', 'number', 'number', 'string']);
    expect([typeof (await get(`/items/${it1.id}/comments`)).data[0].id, typeof (await get('/teams')).data[0].id, typeof (await get(`/teams/${teamA}/members`)).data[0].id]).toEqual(['number', 'number', 'number']);
    expect(Object.values(await get('/dashboard/summary')).every((v) => typeof v === 'number')).toBe(true);
    expect(typeof (await get('/dashboard/summary')).overdue).toBe('number'); expect(typeof (await get('/items?limit=1')).nextCursor === 'number' || (await get('/items?limit=1')).nextCursor === null).toBe(true);
  });
});

describe('authentication hardening', () => {
  const login = (email: string, password: string) => request(app).post('/api/v1/auth/login').send({ email, password });
  afterEach(async () => { await pool.query('DELETE FROM login_attempts'); });
  it('locks email+IP after 10 failures (429 + Retry-After), even for the correct password; other accounts are unaffected', async () => {
    for (let i = 0; i < 10; i++) expect((await login('member2@demo.test', 'bad')).status).toBe(401);
    const blocked = await login('member2@demo.test', 'demo-local-only');
    expect(blocked.status).toBe(429); expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS'); expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login('viewer@demo.test', 'demo-local-only')).status).toBe(200);
    await pool.query(`UPDATE login_attempts SET window_start = now() - interval '16 minutes'`);
    expect((await login('member2@demo.test', 'demo-local-only')).status).toBe(200);
  });
  it('counts unknown emails the same way (no account enumeration) and a success resets the counter', async () => {
    for (let i = 0; i < 10; i++) await login('nobody@demo.test', 'bad');
    expect((await login('nobody@demo.test', 'bad')).status).toBe(429);
    for (let i = 0; i < 3; i++) await login('lead@demo.test', 'bad');
    expect((await login('lead@demo.test', 'demo-local-only')).status).toBe(200);
    expect(Number((await pool.query(`SELECT count(*) FROM login_attempts WHERE key LIKE 'lead@demo.test|%'`)).rows[0].count)).toBe(0);
  });
  it('logout revokes exactly that token; the same user\'s other tokens keep working', async () => {
    const a = (await login('member@demo.test', 'demo-local-only')).body.token, b = (await login('member@demo.test', 'demo-local-only')).body.token;
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${a}`)).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${a}`)).status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${a}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/items').set('Authorization', `Bearer ${a}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${b}`)).status).toBe(200);
  });
  it('rejects a correctly signed token that has no jti', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    expect((await request(app).get('/api/v1/items').set('Authorization', `Bearer ${jwt.sign({ sub: String(ids.member) }, 'test-only-secret', { algorithm: 'HS256', expiresIn: '15m' })}`)).status).toBe(401);
  });
  it('sends security headers and does not advertise Express', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-frame-options']).toBe('DENY'); expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'"); expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers['x-powered-by']).toBeUndefined();
  });
});


// ====================== audit additions (real PostgreSQL, real HTTP via supertest) ======================
const evCount = async (id: number) => Number((await pool.query('SELECT count(*) FROM activity_events WHERE work_item_id=$1', [id])).rows[0].count);
const world = async (id?: number) => ({ items: await count('work_items'), events: await count('activity_events'), outbox: await count('outbox_jobs'), comments: await count('comments'), idem: await count('idempotency_records'),
  row: id ? (await pool.query('SELECT status,version,assignee_id,priority,title,description FROM work_items WHERE id=$1', [id])).rows[0] : null });
const transit = (u: string, id: number, to: string, v: number) => request(app).post(`/api/v1/items/${id}/transition`).set(as(u)).send({ to, expectedVersion: v });
const pathTo = (target: Status): Status[] => { // shortest route through the shared transition map, starting from OPEN
  const frontier: [Status, Status[]][] = [['OPEN', []]]; const seen = new Set<Status>(['OPEN']);
  while (frontier.length) { const [s, p] = frontier.shift()!; if (s === target) return p; for (const n of Object.keys(TRANSITIONS[s]) as Status[]) if (!seen.has(n)) { seen.add(n); frontier.push([n, [...p, n]]); } }
  throw new Error('unreachable ' + target);
};
const itemIn = async (status: Status) => { const it = await mk('member'); let v = it.version as number; for (const s of pathTo(status)) { const r = await transit('lead', it.id, s, v); expect(r.status).toBe(200); v = r.body.version; } return { id: it.id as number, v }; };

describe('optimistic locking details', () => {
  it('a no-op PATCH does not bump the version, write an event, or queue a job; a stale no-op still conflicts', async () => {
    const it1 = await mk(); const before = await world(it1.id); const url = `/api/v1/items/${it1.id}`;
    for (const body of [{ expectedVersion: 1, title: it1.title }, { expectedVersion: 1 }, { expectedVersion: 1, priority: it1.priority, description: it1.description }]) {
      const r = await request(app).patch(url).set(as('member')).send(body); expect(r.status).toBe(200); expect(r.body.version).toBe(1);
    }
    expect(await world(it1.id)).toEqual(before);
    expect((await request(app).patch(url).set(as('member')).send({ expectedVersion: 1, title: 'real change' })).body.version).toBe(2);
    const stale = await request(app).patch(url).set(as('member')).send({ expectedVersion: 1, title: 'real change' }); // same values, stale view
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('STALE_VERSION');
  });
  it('rejects client-supplied status / actorId / version instead of silently ignoring them', async () => {
    const it1 = await mk(); const before = await world(it1.id);
    const r = await request(app).patch(`/api/v1/items/${it1.id}`).set(as('member')).send({ expectedVersion: 1, status: 'RESOLVED', actorId: ids.lead, version: 9, title: 'x' });
    expect(r.status).toBe(422); expect(Object.keys(r.body.error.details).sort()).toEqual(['actorId', 'status', 'version']);
    expect(await world(it1.id)).toEqual(before);
  });
  it('two simultaneous updates on the same version: exactly one wins, version rises once, the loser leaves no trace', async () => {
    const it1 = await mk(); const url = `/api/v1/items/${it1.id}`;
    const rs = await Promise.all([request(app).patch(url).set(as('member')).send({ expectedVersion: 1, title: 'A wins?' }), request(app).patch(url).set(as('lead')).send({ expectedVersion: 1, title: 'B wins?' })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = rs.find((r) => r.status === 200)!; const row = (await pool.query('SELECT title,version FROM work_items WHERE id=$1', [it1.id])).rows[0];
    expect(row).toEqual({ title: winner.body.title, version: 2 });
    expect((await pool.query(`SELECT count(*)::int c FROM activity_events WHERE work_item_id=$1 AND event_type='TITLE_CHANGED'`, [it1.id])).rows[0].c).toBe(1);
  });
});

describe('idempotency details', () => {
  const create = (u: string, key: string, title: string) => request(app).post('/api/v1/items').set(as(u)).set('Idempotency-Key', key).send({ title, teamId: teamA });
  it('a failed transaction leaves no item, no idempotency record, no outbox job; the same key then succeeds and replays', async () => {
    const before = await world();
    hooks.afterUpdate = () => { throw new Error('boom'); };
    try { expect((await create('member', 'fail-key', 'Never created')).status).toBe(500); } finally { hooks.afterUpdate = undefined; }
    expect(await world()).toEqual(before);
    const ok = await create('member', 'fail-key', 'Never created'); const replay = await create('member', 'fail-key', 'Never created');
    expect(ok.status).toBe(201); expect(replay.status).toBe(201); expect(replay.body).toEqual(ok.body); expect(replay.headers['idempotent-replay']).toBe('true');
  });
  it('keys are scoped per actor; an expired record (24h retention) no longer blocks the key', async () => {
    const a = await create('member', 'scope-key', 'Same'); const b = await create('member2', 'scope-key', 'Same'); expect(a.body.id).not.toBe(b.body.id);
    expect((await create('member', 'scope-key', 'Different')).status).toBe(409); // within retention: reuse with another payload is rejected
    await pool.query(`UPDATE idempotency_records SET expires_at = now() - interval '1 minute' WHERE key='scope-key' AND actor_id=$1`, [ids.member]);
    const again = await create('member', 'scope-key', 'Different'); expect(again.status).toBe(201); expect(again.body.title).toBe('Different'); expect(again.body.id).not.toBe(a.body.id);
  });
});

describe('workflow: complete transition matrix over HTTP', () => {
  it('every (from,to) pair behaves exactly as the shared map says, with consistent version/event/outbox effects', async () => {
    const STATES = Object.keys(TRANSITIONS) as Status[]; let allowedSeen = 0, deniedSeen = 0;
    for (const from of STATES) for (const to of STATES) {
      const { id, v } = await itemIn(from); const min = TRANSITIONS[from][to]; const before = await world(id); const evBefore = await evCount(id);
      if (!min) { // not an edge: even a Lead gets 409 and nothing changes
        const r = await transit('lead', id, to, v); expect([from, to, r.status, r.body.error?.code]).toEqual([from, to, 409, 'INVALID_TRANSITION']); expect(await world(id)).toEqual(before); deniedSeen++; continue;
      }
      const viewer = await transit('viewer', id, to, v); expect([from, to, viewer.status]).toEqual([from, to, 403]); // read-only role can never move work
      if (min === 'LEAD') { const m = await transit('member', id, to, v); expect([from, to, m.status]).toEqual([from, to, 403]); }
      expect(await world(id)).toEqual(before);
      const ok = await transit(min === 'LEAD' ? 'lead' : 'member', id, to, v); expect([from, to, ok.status]).toEqual([from, to, 200]);
      expect(ok.body.status).toBe(to); expect(ok.body.version).toBe(v + 1); expect(await evCount(id)).toBe(evBefore + 1); allowedSeen++;
    }
    expect([allowedSeen, deniedSeen]).toEqual([7, 18]); // 7 edges in the map, 25 pairs in total
  }, 90000);
  it('an ADMIN can approve and the approval is attributed to them; a rejection is recorded as APPROVAL_REJECTED', async () => {
    const hash = await argon2.hash('demo-local-only'); const aid = (await pool.query(`INSERT INTO users(name,email,password_hash) VALUES('Admin Two','admin2@demo.test',$1) RETURNING id`, [hash])).rows[0].id;
    await pool.query(`INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,'ADMIN')`, [aid, teamA]); tok.admin2 = (await request(app).post('/api/v1/auth/login').send({ email: 'admin2@demo.test', password: 'demo-local-only' })).body.token;
    const a = await itemIn('AWAITING_APPROVAL'); const ok = await transit('admin2', a.id, 'RESOLVED', a.v); expect(ok.status).toBe(200);
    expect((await pool.query(`SELECT actor_id FROM activity_events WHERE work_item_id=$1 AND event_type='APPROVED'`, [a.id])).rows).toEqual([{ actor_id: aid }]);
    const b = await itemIn('AWAITING_APPROVAL'); expect((await transit('lead', b.id, 'IN_PROGRESS', b.v)).status).toBe(200);
    expect((await pool.query(`SELECT actor_id FROM activity_events WHERE work_item_id=$1 AND event_type='APPROVAL_REJECTED'`, [b.id])).rows).toEqual([{ actor_id: ids.lead }]);
  });
});

describe('authorization matrix: role x route', () => {
  const actors = ['member', 'viewer', 'lead', 'outsider', 'none', 'invalid'] as const;
  const send = (method: 'get' | 'post' | 'patch', path: string, actor: (typeof actors)[number], body?: object) => {
    const r = (request(app) as any)[method](`/api/v1${path}`); if (actor === 'invalid') r.set('Authorization', 'Bearer garbage'); else if (actor !== 'none') r.set(as(actor)); return body ? r.send(body) : r;
  };
  const READ = { member: 200, viewer: 200, lead: 200, outsider: 404, none: 401, invalid: 401 }, WRITE = { member: 200, viewer: 403, lead: 200, outsider: 404, none: 401, invalid: 401 };
  const cases: [string, (i: number, v: number) => ['get' | 'post' | 'patch', string, object?], Record<string, number>][] = [
    ['GET item', (i) => ['get', `/items/${i}`], READ], ['GET activity', (i) => ['get', `/items/${i}/activity`], READ], ['GET comments', (i) => ['get', `/items/${i}/comments`], READ],
    ['POST comment', (i) => ['post', `/items/${i}/comments`, { body: 'hi' }], { ...WRITE, member: 201, lead: 201 }],
    ['PATCH edit', (i, v) => ['patch', `/items/${i}`, { expectedVersion: v, title: 'edited' }], WRITE], ['POST claim', (i) => ['post', `/items/${i}/claim`], WRITE],
    ['POST transition', (i, v) => ['post', `/items/${i}/transition`, { to: 'IN_PROGRESS', expectedVersion: v }], WRITE],
    ['PATCH reassign', (i, v) => ['patch', `/items/${i}`, { expectedVersion: v, assigneeId: ids.member2 }], { ...WRITE, member: 403 }],
  ];
  it('each role gets exactly the status the policy says on every item route (404 hides existence from non-members, 403 means "you are a member without the role")', async () => {
    for (const [name, build, expected] of cases) for (const actor of actors) {
      const it1 = await mk(); const [m, p, b] = build(it1.id, it1.version); const r = await send(m, p, actor, b);
      expect([name, actor, r.status]).toEqual([name, actor, expected[actor]]);
    }
  });
  it('POST /items: members and leads create; viewers and non-members are refused; anonymous is 401', async () => {
    const want: Record<string, number> = { member: 201, lead: 201, viewer: 403, outsider: 403, none: 401, invalid: 401 };
    for (const actor of actors) expect([actor, (await send('post', '/items', actor, { title: 'authz create', teamId: teamA })).status]).toEqual([actor, want[actor]]);
  });
  it('a 404 for a non-member is indistinguishable from a 404 for an item that does not exist (no existence leak)', async () => {
    const it1 = await mk(); const real = await send('get', `/items/${it1.id}`, 'outsider'); const missing = await send('get', '/items/99999999', 'outsider');
    expect(real.status).toBe(404); expect(real.body).toEqual(missing.body);
  });
});

describe('activity ledger: accuracy, ordering, immutability, atomicity', () => {
  it('creation writes exactly one CREATED; edits record before/after, the authenticated actor, in id order', async () => {
    const it1 = (await request(app).post('/api/v1/items').set(as('member')).send({ title: 'Ledger', teamId: teamA, priority: 'MEDIUM', dueAt: '2030-01-01T00:00:00.000Z' })).body; const url = `/api/v1/items/${it1.id}`;
    expect(await evCount(it1.id)).toBe(1);
    expect((await request(app).patch(url).set(as('member')).send({ expectedVersion: 1, priority: 'HIGH', title: 'Ledger 2', dueAt: '2031-02-03T04:05:06.000Z' })).status).toBe(200);
    expect((await request(app).patch(url).set(as('lead')).send({ expectedVersion: 2, assigneeId: ids.member2 })).status).toBe(200);
    expect((await request(app).post(`${url}/comments`).set(as('viewer')).send({ body: 'nope' })).status).toBe(403); // refused action leaves no event
    expect((await request(app).post(`${url}/comments`).set(as('member2')).send({ body: 'noted' })).status).toBe(201);
    const ev = (await pool.query('SELECT id,actor_id,event_type,previous_value,new_value FROM activity_events WHERE work_item_id=$1 ORDER BY id', [it1.id])).rows;
    const by = (t: string) => ev.find((e) => e.event_type === t);
    expect(ev.map((e) => e.event_type).filter((t) => t === 'CREATED')).toHaveLength(1);
    expect(by('PRIORITY_CHANGED')).toMatchObject({ actor_id: ids.member, previous_value: 'MEDIUM', new_value: 'HIGH' });
    expect(by('TITLE_CHANGED')).toMatchObject({ previous_value: 'Ledger', new_value: 'Ledger 2' });
    expect(by('DUE_AT_CHANGED')).toMatchObject({ previous_value: '2030-01-01T00:00:00.000Z', new_value: '2031-02-03T04:05:06.000Z' });
    expect(by('ASSIGNEE_ID_CHANGED')).toMatchObject({ actor_id: ids.lead, previous_value: null, new_value: ids.member2 });
    expect(by('COMMENTED')).toMatchObject({ actor_id: ids.member2 }); expect(ev.some((e) => e.actor_id === ids.viewer)).toBe(false);
    expect(ev.map((e) => e.id)).toEqual([...ev.map((e) => e.id)].sort((a, b) => a - b));
  });
  it('the database itself refuses to UPDATE or DELETE history, and no HTTP route can edit it', async () => {
    const it1 = await mk();
    await expect(pool.query(`UPDATE activity_events SET event_type='TAMPERED' WHERE work_item_id=$1`, [it1.id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM activity_events WHERE work_item_id=$1', [it1.id])).rejects.toThrow(/append-only/);
    for (const m of ['put', 'patch', 'delete', 'post'] as const) expect([m, (await (request(app) as any)[m](`/api/v1/items/${it1.id}/activity`).set(as('lead')).send({})).status]).toEqual([m, 404]);
  });
  it('a failure after the business write rolls back EVERYTHING on every mutation path: row, activity, outbox, comments, idempotency', async () => {
    const mut: [string, () => Promise<{ id?: number; call: () => request.Test }>][] = [
      ['create', async () => ({ call: () => request(app).post('/api/v1/items').set(as('member')).set('Idempotency-Key', 'atomic-' + Math.random()).send({ title: 'atomic', teamId: teamA }) })],
      ['edit', async () => { const i = await mk(); return { id: i.id, call: () => request(app).patch(`/api/v1/items/${i.id}`).set(as('member')).send({ expectedVersion: 1, title: 'atomic edit', priority: 'URGENT' }) }; }],
      ['claim', async () => { const i = await mk(); return { id: i.id, call: () => request(app).post(`/api/v1/items/${i.id}/claim`).set(as('member')) }; }],
      ['transition (queues an outbox job)', async () => { const i = await itemIn('IN_PROGRESS'); return { id: i.id, call: () => transit('member', i.id, 'AWAITING_APPROVAL', i.v) }; }],
      ['approval', async () => { const i = await itemIn('AWAITING_APPROVAL'); return { id: i.id, call: () => transit('lead', i.id, 'RESOLVED', i.v) }; }],
      ['comment', async () => { const i = await mk(); return { id: i.id, call: () => request(app).post(`/api/v1/items/${i.id}/comments`).set(as('member')).send({ body: 'atomic comment' }) }; }],
    ];
    for (const [name, setup] of mut) {
      const { id, call } = await setup(); const before = await world(id);
      hooks.afterUpdate = () => { throw new Error('boom'); };
      try { expect([name, (await call()).status]).toEqual([name, 500]); } finally { hooks.afterUpdate = undefined; }
      expect([name, await world(id)]).toEqual([name, before]);
    }
  }, 60000);
});

describe('outbox worker lifecycle (real PostgreSQL)', () => {
  const addJob = async () => Number((await pool.query(`INSERT INTO outbox_jobs(event_type,payload) VALUES('ITEM_CREATED','{"itemId":1,"reference":"OPS-00001"}') RETURNING id`)).rows[0].id);
  const job = async (id: number) => (await pool.query('SELECT status,attempts,locked_at,processed_at,last_error,EXTRACT(EPOCH FROM (available_at-now()))::float AS due_in FROM outbox_jobs WHERE id=$1', [id])).rows[0];
  const due = (id: number) => pool.query('UPDATE outbox_jobs SET available_at=now() WHERE id=$1', [id]);
  beforeEach(async () => { await pool.query('TRUNCATE outbox_jobs, notifications RESTART IDENTITY CASCADE'); });
  it('processes a job once: DONE, lease cleared, one notification, nothing left to do', async () => {
    const id = await addJob(); expect(await runOnce(notify)).toBe(true);
    expect(await job(id)).toMatchObject({ status: 'DONE', attempts: 1, locked_at: null }); expect((await job(id)).processed_at).not.toBeNull();
    expect(await count('notifications')).toBe(1); expect(await runOnce(notify)).toBe(false);
  });
  it('transient failure: backs off (not retried early), then succeeds on the next due attempt', async () => {
    const id = await addJob(); let calls = 0; const flaky = async (j: any) => { if (++calls === 1) throw new Error('transient'); await notify(j); };
    await runOnce(flaky); expect(await job(id)).toMatchObject({ status: 'PENDING', attempts: 1, locked_at: null }); expect((await job(id)).due_in).toBeGreaterThan(0);
    expect(await runOnce(flaky)).toBe(false); await due(id); await runOnce(flaky);
    expect(await job(id)).toMatchObject({ status: 'DONE', attempts: 2, locked_at: null }); expect(await count('notifications')).toBe(1);
  });
  it('maximum attempts: ends FAILED with the lease cleared and is never retried again', async () => {
    const id = await addJob(); let calls = 0; const bad = async () => { calls++; throw new Error('always'); };
    for (let i = 0; i < 3; i++) { await due(id); await runOnce(bad, { maxAttempts: 3 }); }
    expect(await job(id)).toMatchObject({ status: 'FAILED', attempts: 3, locked_at: null, last_error: 'always' });
    await due(id); expect(await runOnce(bad, { maxAttempts: 3 })).toBe(false); expect(calls).toBe(3);
  });
  it('a PermanentJobError fails the job immediately (no pointless retries)', async () => {
    const id = await addJob(); await runOnce(async () => { throw new PermanentJobError('malformed payload'); }, { maxAttempts: 5 });
    expect(await job(id)).toMatchObject({ status: 'FAILED', attempts: 1, locked_at: null, last_error: 'malformed payload' });
  });
  it('lease expiry: a job abandoned by a crashed worker is recovered; a fresh lease is left alone', async () => {
    const id = await addJob(); await pool.query(`UPDATE outbox_jobs SET status='PROCESSING', locked_at=now()-interval '10 seconds', attempts=1 WHERE id=$1`, [id]);
    expect(await runOnce(notify, { leaseSeconds: 60 })).toBe(false); expect(await job(id)).toMatchObject({ status: 'PROCESSING', attempts: 1 });
    await pool.query(`UPDATE outbox_jobs SET locked_at=now()-interval '120 seconds' WHERE id=$1`, [id]);
    expect(await runOnce(notify, { leaseSeconds: 60 })).toBe(true); expect(await job(id)).toMatchObject({ status: 'DONE', attempts: 2, locked_at: null }); expect(await count('notifications')).toBe(1);
  });
  it('an abandoned job that already used all its attempts is FAILED, not processed again', async () => {
    const id = await addJob(); await pool.query(`UPDATE outbox_jobs SET status='PROCESSING', locked_at=now()-interval '120 seconds', attempts=5 WHERE id=$1`, [id]); let called = false;
    expect(await runOnce(async () => { called = true; }, { maxAttempts: 5, leaseSeconds: 60 })).toBe(false);
    expect(called).toBe(false); expect(await job(id)).toMatchObject({ status: 'FAILED', locked_at: null }); expect((await job(id)).last_error).toMatch(/lease expired/);
  });
  it('two workers racing for one abandoned job: exactly one processes it', async () => {
    const id = await addJob(); await pool.query(`UPDATE outbox_jobs SET status='PROCESSING', locked_at=now()-interval '120 seconds', attempts=1 WHERE id=$1`, [id]); let n = 0;
    await Promise.all([runOnce(async () => { n++; }, { leaseSeconds: 60 }), runOnce(async () => { n++; }, { leaseSeconds: 60 }), runOnce(async () => { n++; }, { leaseSeconds: 60 })]);
    expect(n).toBe(1); expect(await job(id)).toMatchObject({ status: 'DONE', attempts: 2 });
  });
  it('at-least-once delivery: a crash AFTER the side effect causes a redelivery, and the notification still exists exactly once', async () => {
    const id = await addJob(); let calls = 0; const crashy = async (j: any) => { await notify(j); if (++calls === 1) throw new Error('crashed after side effect'); };
    await runOnce(crashy); await due(id); await runOnce(crashy);
    expect(calls).toBe(2); expect(await job(id)).toMatchObject({ status: 'DONE', attempts: 2 }); expect(await count('notifications')).toBe(1);
  });
  it('backoff is bounded, and stored/logged errors never contain credentials', async () => {
    const id = await addJob(); await pool.query('UPDATE outbox_jobs SET attempts=20 WHERE id=$1', [id]);
    await runOnce(async () => { throw new Error('connect postgres://admin:hunter2@db.example/prod failed token=abc123 password=zzz'); }, { maxAttempts: 100, maxBackoffSeconds: 30 });
    const j = await job(id); expect(j.status).toBe('PENDING'); expect(j.due_in).toBeGreaterThan(0); expect(j.due_in).toBeLessThanOrEqual(31);
    for (const secret of ['hunter2', 'abc123', 'zzz']) { expect(j.last_error).not.toContain(secret); expect(redactError(new Error(`x ${secret}`))).toContain(secret === 'zzz' ? 'zzz' : secret); }
    expect(redactError(new Error('postgres://u:p4ss@h/db'))).toBe('postgres://***@h/db');
  });
  it('a real worker process drains a job and shuts down cleanly on SIGTERM', async () => {
    const id = await addJob(); const out: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], { env: { ...process.env, WORKER_LOG: 'on' }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (d) => out.push(String(d)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
    let done = false; for (let i = 0; i < 80 && !done; i++) { await new Promise((r) => setTimeout(r, 250)); done = (await job(id)).status === 'DONE'; }
    expect(done).toBe(true); child.kill('SIGTERM');
    const result = await exited;
    if (process.platform === 'win32') {
      // Windows terminates child processes for SIGTERM instead of delivering it to the worker's handler.
      expect(result).toMatchObject({ code: null, signal: 'SIGTERM' });
      return;
    }
    expect(result).toEqual({ code: 0, signal: null }); expect(out.join('')).toContain('worker stopping');
  }, 30000);
});

describe('migrations (runs last: it rebuilds the schema)', () => {
  it('is versioned and idempotent, and upgrades a database created before the runner existed', async () => {
    const { readFileSync } = await import('node:fs');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(readFileSync('db/migrations/001_init.sql', 'utf8')); // legacy: schema present, no schema_migrations table
    expect(await applyMigrations(pool)).toEqual(['002_auth_hardening.sql', '003_activity_append_only.sql']);
    expect((await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name)).toEqual(['001_init.sql', '002_auth_hardening.sql', '003_activity_append_only.sql']);
    expect(await applyMigrations(pool)).toEqual([]);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    expect(await applyMigrations(pool)).toEqual(['001_init.sql', '002_auth_hardening.sql', '003_activity_append_only.sql']); // fresh database
    await pool.query('INSERT INTO teams(name,slug) VALUES($1,$2)', ['t', 't']); // schema is usable
  });
});

describe('migration + configuration safety', () => {
  const dirWith = (files: Record<string, string>) => { const d = mkdtempSync(tmpdir() + '/mig-'); for (const [n, sql] of Object.entries(files)) writeFileSync(`${d}/${n}`, sql); return pathToFileURL(d + '/'); };
  const fresh = () => pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  it('a failing migration is rolled back completely and named in the error; nothing is recorded for it', async () => {
    await fresh(); const dir = dirWith({ '001_ok.sql': 'CREATE TABLE t_ok(id int);', '002_bad.sql': 'CREATE TABLE t_half(id int); SELECT * FROM table_that_does_not_exist;' });
    await expect(applyMigrations(pool, dir)).rejects.toThrow(/Migration 002_bad\.sql failed and was rolled back/);
    expect((await pool.query(`SELECT to_regclass('t_ok') IS NOT NULL ok, to_regclass('t_half') IS NOT NULL half`)).rows[0]).toEqual({ ok: true, half: false });
    expect((await pool.query('SELECT name FROM schema_migrations')).rows).toEqual([{ name: '001_ok.sql' }]);
  });
  it('refuses a database that has only some application tables instead of assuming it is migrated', async () => {
    await fresh(); await pool.query('CREATE TABLE users(id int)');
    await expect(applyMigrations(pool)).rejects.toThrow(/Refusing to migrate.*missing:/);
    expect((await pool.query('SELECT count(*)::int c FROM schema_migrations')).rows[0].c).toBe(0);
  });
  it('refuses a database that is ahead of the code (unknown recorded migration)', async () => {
    await fresh(); await applyMigrations(pool); await pool.query(`INSERT INTO schema_migrations(name) VALUES('999_from_the_future.sql')`);
    await expect(applyMigrations(pool)).rejects.toThrow(/does not know about \(999_from_the_future\.sql\)/);
  });
  it('the API/migrate CLI fails fast with a clear message when DATABASE_URL is missing', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('DATABASE_URL is not set');
  });
  it('the seed script refuses to run (and wipes nothing) when NODE_ENV=production', async () => {
    await fresh(); await applyMigrations(pool); await pool.query(`INSERT INTO users(name,email,password_hash) VALUES('keep','keep@x.test','h')`);
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/seed.ts'], { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' });
    expect(r.status).toBe(1); expect(r.stderr).toContain('Refusing to seed'); expect((await pool.query('SELECT count(*)::int c FROM users')).rows[0].c).toBe(1);
  });
});
