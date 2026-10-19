// End-to-end check against a RUNNING API + seeded DB. Usage: BASE=http://localhost:3000 DATABASE_URL=... node scripts/e2e.mjs
import pg from 'pg';
const BASE = process.env.BASE ?? 'http://localhost:3000'; const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fails = 0; const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + extra}`); if (!cond) fails++; };
const call = async (method, path, tok, body, headers = {}) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const login = async (u) => (await call('POST', '/auth/login', null, { email: `${u}@demo.test`, password: 'demo-local-only' })).body.token;
const q = async (sql, a = []) => (await pool.query(sql, a)).rows;
const T = Object.fromEntries(await Promise.all(['admin', 'lead', 'member', 'member2', 'viewer', 'nora'].map(async (u) => [u, await login(u)])));
const id = async (email) => (await q('SELECT id FROM users WHERE email=$1', [email + '@demo.test']))[0].id;

// --- auth ---
check('invalid password -> 401', (await call('POST', '/auth/login', null, { email: 'member@demo.test', password: 'nope' })).status === 401);
check('no token -> 401', (await call('GET', '/items')).status === 401);
check('garbage token -> 401', (await call('GET', '/items', 'abc.def.ghi')).status === 401);
const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url') + '.';
check('alg=none forged token -> 401', (await call('GET', '/items', none)).status === 401);
const me = (await call('GET', '/auth/me', T.member)).body; check('/auth/me returns user + memberships', me.user.name && me.memberships.length === 2);
const teams = (await call('GET', '/teams', T.member)).body.data; const platform = teams.find((t) => t.slug === 'platform').id;

// --- dashboard vs independent SQL ground truth ---
for (const u of ['member', 'lead', 'viewer', 'nora']) {
  const uid = await id(u); const s = (await call('GET', '/dashboard/summary', T[u])).body;
  const g = (await q(`SELECT
    count(*) FILTER (WHERE w.assignee_id=$1 AND w.status NOT IN ('RESOLVED','CLOSED'))::int a,
    count(*) FILTER (WHERE w.assignee_id IS NULL AND w.priority='URGENT' AND w.status NOT IN ('RESOLVED','CLOSED'))::int b,
    count(*) FILTER (WHERE w.status='AWAITING_APPROVAL' AND m.role IN ('LEAD','ADMIN'))::int c,
    count(*) FILTER (WHERE w.due_at<now() AND w.status NOT IN ('RESOLVED','CLOSED'))::int d
    FROM work_items w JOIN memberships m ON m.team_id=w.team_id AND m.user_id=$1`, [uid]))[0];
  check(`dashboard summary matches SQL truth (${u})`, s.assignedToMe === g.a && s.unassignedUrgent === g.b && s.awaitingMyApproval === g.c && s.overdue === g.d, JSON.stringify([s, g]));
}

for (const u of ['member', 'lead', 'viewer']) {
  const uid = await id(u); const s = (await call('GET', '/dashboard/summary', T[u])).body; const n = async (qs) => { let c, t = 0; do { const r = (await call('GET', `/items?limit=100${qs}${c ? '&cursor=' + c : ''}`, T[u])).body; t += r.data.length; c = r.nextCursor; } while (c); return t; };
  check(`tile lists equal tile counts (${u}): assigned/approval/urgent/overdue`, (await n(`&assigneeId=${uid}&active=true`)) === s.assignedToMe && (await n('&approvable=true')) === s.awaitingMyApproval && (await n('&unassigned=true&priority=URGENT&active=true')) === s.unassignedUrgent && (await n('&overdue=true')) === s.overdue, JSON.stringify(s));
}
// --- pagination over HTTP ---
let cur, seen = [], pages = 0;
do { const r = (await call('GET', `/items?limit=7${cur ? '&cursor=' + cur : ''}`, T.member)).body; seen.push(...r.data.map((i) => i.id)); cur = r.nextCursor; pages++; } while (cur);
const visible = Number((await q(`SELECT count(*) FROM work_items w JOIN memberships m ON m.team_id=w.team_id AND m.user_id=$1`, [await id('member')]))[0].count);
check('cursor pagination walks every visible item exactly once, descending', seen.length === visible && new Set(seen).size === visible && seen.every((v, i) => i === 0 || v < seen[i - 1]), `${seen.length}/${visible} pages=${pages}`);
const od = (await call('GET', '/items?overdue=true&limit=100', T.member)).body.data; check('overdue filter returns only overdue open items', od.length > 0 && od.every((i) => new Date(i.due_at) < new Date() && !['RESOLVED', 'CLOSED'].includes(i.status)));
const sr = (await call('GET', '/items?q=failover&limit=100', T.member)).body.data; check('search matches title server-side', sr.length > 0 && sr.every((i) => /failover/i.test(i.title + i.description + i.reference)));
check('limit>100 -> 422', (await call('GET', '/items?limit=101', T.member)).status === 422);

// --- create + idempotency ---
const title = 'E2E ' + Date.now(); const payload = { title, description: 'e2e', priority: 'URGENT', teamId: platform };
const key = 'e2e-' + Date.now();
const par = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', '/items', T.member, payload, { 'Idempotency-Key': key })));
const ids = new Set(par.map((r) => r.body.id)); check('5 simultaneous identical creates -> one item id', ids.size === 1 && par.every((r) => r.status === 201), JSON.stringify(par.map((r) => r.status)));
check('DB has exactly one row for that title', (await q('SELECT count(*) FROM work_items WHERE title=$1', [title]))[0].count === '1');
check('same key, different payload -> 409 IDEMPOTENCY_KEY_REUSED', (await call('POST', '/items', T.member, { ...payload, title: 'other' }, { 'Idempotency-Key': key })).body?.error?.code === 'IDEMPOTENCY_KEY_REUSED');
const item = par[0].body; const url = `/items/${item.id}`; check('created item has reference + version 1', /^OPS-\d{5}$/.test(item.reference) && item.version === 1);
check('create without idempotency key still works', (await call('POST', '/items', T.member, { ...payload, title: title + ' b' })).status === 201);
check('empty title -> 422 with field errors', (await call('POST', '/items', T.member, { ...payload, title: ' ' })).body?.error?.details?.title);
check('viewer cannot create -> 403', (await call('POST', '/items', T.viewer, payload)).status === 403);
check('non-member cannot create in team -> 403', (await call('POST', '/items', T.nora, payload)).status === 403);

// --- edit ---
let v = 1; let r = await call('PATCH', url, T.member, { expectedVersion: v, title: title + ' edited', priority: 'HIGH' }); v = r.body.version;
check('edit increments version', r.status === 200 && v === 2);
// --- stale update, truly parallel ---
const [a, b] = await Promise.all([call('PATCH', url, T.member, { expectedVersion: v, description: 'from member' }), call('PATCH', url, T.lead, { expectedVersion: v, description: 'from lead' })]);
const win = [a, b].filter((x) => x.status === 200), lose = [a, b].filter((x) => x.status === 409);
check('parallel edits on same version: exactly one wins, one STALE_VERSION', win.length === 1 && lose.length === 1 && lose[0].body.error.code === 'STALE_VERSION');
const cur2 = (await call('GET', url, T.member)).body; check('stored data is the winner only; version +1', cur2.description === win[0].body.description && cur2.version === 3);
check('stale edit with old version -> 409 and no overwrite', (await call('PATCH', url, T.member, { expectedVersion: 1, title: 'STALE' })).status === 409 && (await call('GET', url, T.member)).body.title !== 'STALE');

// --- claim race over real HTTP ---
const claims = await Promise.all(['member', 'member2', 'lead', 'admin'].flatMap((u) => [1, 2, 3, 4].map(() => call('POST', `${url}/claim`, T[u]))));
check('16 simultaneous claims: exactly one 200, fifteen 409 ALREADY_CLAIMED', claims.filter((c) => c.status === 200).length === 1 && claims.filter((c) => c.status === 409 && c.body.error.code === 'ALREADY_CLAIMED').length === 15);
check('exactly one CLAIMED event', (await q(`SELECT count(*) FROM activity_events WHERE work_item_id=$1 AND event_type='CLAIMED'`, [item.id]))[0].count === '1');
const claimed = (await call('GET', url, T.member)).body; check('claim moved OPEN -> IN_PROGRESS and set assignee', claimed.status === 'IN_PROGRESS' && claimed.assignee_id); v = claimed.version;
check('claim version = 4 (create, edit, edit, claim)', v === 4, String(v));

// --- workflow + approval ---
const tr = (u, to, ver) => call('POST', `${url}/transition`, T[u], { to, expectedVersion: ver, note: 'e2e' });
check('invalid jump IN_PROGRESS -> RESOLVED -> 409', (await tr('lead', 'RESOLVED', v)).body?.error?.code === 'INVALID_TRANSITION');
r = await tr('member', 'AWAITING_APPROVAL', v); check('member -> AWAITING_APPROVAL ok', r.status === 200); v = r.body.version;
check('member cannot approve -> 403', (await tr('member', 'RESOLVED', v)).status === 403);
check('viewer cannot transition -> 403', (await tr('viewer', 'RESOLVED', v)).status === 403);
check('transition with stale version -> 409', (await tr('lead', 'RESOLVED', v - 1)).body?.error?.code === 'STALE_VERSION');
r = await tr('lead', 'RESOLVED', v); check('lead approves -> RESOLVED, resolved_at set', r.status === 200 && r.body.resolved_at); v = r.body.version;
check('CLOSED -> anything is rejected', (await tr('member', 'CLOSED', v).then(async (x) => (await tr('member', 'OPEN', x.body.version)).status)) === 409);
v = (await call('GET', url, T.member)).body.version;

// --- comments ---
check('member can comment', (await call('POST', `${url}/comments`, T.member, { body: 'hello from e2e' })).status === 201);
check('viewer cannot comment -> 403', (await call('POST', `${url}/comments`, T.viewer, { body: 'x' })).status === 403);
check('viewer can read comments', (await call('GET', `${url}/comments`, T.viewer)).body.data.length === 1);
check('empty comment -> 422', (await call('POST', `${url}/comments`, T.member, { body: '  ' })).status === 422);

// --- authorization boundary: nora is not in Platform ---
for (const [m, p] of [['GET', ''], ['GET', '/activity'], ['GET', '/comments'], ['POST', '/claim']]) check(`outsider ${m} ${p || 'detail'} -> 404`, (await call(m, url + p, T.nora)).status === 404);
check('outsider PATCH -> 404', (await call('PATCH', url, T.nora, { expectedVersion: 1, title: 'x' })).status === 404);
check('outsider transition -> 404', (await call('POST', `${url}/transition`, T.nora, { to: 'OPEN', expectedVersion: 1 })).status === 404);
check('outsider list never contains Platform items', (await call('GET', '/items?limit=100', T.nora)).body.data.every((i) => i.team_id !== platform));
check('outsider cannot read Platform members -> 404', (await call('GET', `/teams/${platform}/members`, T.nora)).status === 404);
check('non-numeric id -> 422, unknown id -> 404', (await call('GET', '/items/abc', T.member)).status === 422 && (await call('GET', '/items/99999999', T.member)).status === 404);
const lead = await id('lead'), outsider = await id('nora');
// The claim race above has a random winner: pick a reassignment target that is NOT the current assignee so this step is deterministic.
const holder = (await call('GET', url, T.member)).body.assignee_id; const target = holder === await id('member2') ? await id('member') : await id('member2');
check('lead can reassign to a different team member', (await call('PATCH', url, T.lead, { expectedVersion: v, assigneeId: target })).status === 200); v++;
const sameAgain = await call('PATCH', url, T.lead, { expectedVersion: v, assigneeId: target });
check('reassigning to the current assignee is a no-op: 200, version unchanged', sameAgain.status === 200 && sameAgain.body.version === v, JSON.stringify([sameAgain.status, sameAgain.body.version, v]));
check('reassign to non-team user -> 422', (await call('PATCH', url, T.lead, { expectedVersion: v, assigneeId: outsider })).status === 422);
check('member cannot reassign -> 403', (await call('PATCH', url, T.member, { expectedVersion: v, assigneeId: lead })).status === 403);
const bypass = await call('PATCH', url, T.member, { expectedVersion: v, actorId: lead, status: 'OPEN', version: 99, description: 'x' });
check('PATCH rejects client-supplied status/actor/version (422, named fields) and changes nothing', bypass.status === 422 && bypass.body.error.details.status && bypass.body.error.details.actorId && (await call('GET', url, T.member)).body.status === 'CLOSED');
v = (await call('GET', url, T.member)).body.version;

// --- activity history ---
const act = (await call('GET', `${url}/activity`, T.viewer)).body.data;
const types = act.map((e) => e.event_type);
check('activity is ordered and has every expected event', ['CREATED', 'TITLE_CHANGED', 'PRIORITY_CHANGED', 'DESCRIPTION_CHANGED', 'CLAIMED', 'STATUS_CHANGED', 'APPROVED', 'COMMENTED', 'ASSIGNEE_ID_CHANGED'].every((t) => types.includes(t)) && act.every((e, i) => i === 0 || e.id > act[i - 1].id), types.join(','));
const ed = act.find((e) => e.event_type === 'TITLE_CHANGED'); check('before/after values recorded', ed.previous_value === title && ed.new_value === title + ' edited');
const ap = act.find((e) => e.event_type === 'APPROVED'); check('approval actor is the lead (from token, not client)', ap.actor_name === 'Lena Lead' && ap.metadata?.note === 'e2e');
const bumps = (await q(`SELECT count(*)::int c FROM activity_events WHERE work_item_id=$1 AND event_type NOT IN ('CREATED','COMMENTED') AND event_type NOT IN ('PRIORITY_CHANGED')`, [item.id]))[0].c;
check('version == 1 + version-bumping mutations (edit counted once)', v === 1 + (bumps - 0) , `version=${v} bumps=${bumps}`);

// --- DB-wide transactional invariants ---
check('no item with version>1 lacks a non-create/comment event', (await q(`SELECT count(*) FROM work_items w WHERE w.version>1 AND NOT EXISTS (SELECT 1 FROM activity_events a WHERE a.work_item_id=w.id AND a.event_type NOT IN ('CREATED','COMMENTED'))`))[0].count === '0');
check('every item has exactly one CREATED event', (await q(`SELECT count(*) FROM work_items w WHERE (SELECT count(*) FROM activity_events a WHERE a.work_item_id=w.id AND a.event_type='CREATED')<>1`))[0].count === '0');
check('outbox has jobs for the created/transitioned items', Number((await q(`SELECT count(*) FROM outbox_jobs WHERE payload->>'itemId'=$1`, [String(item.id)]))[0].count) >= 3);

// --- auth hardening ---
const hh = (await fetch(`${BASE}/health`)).headers;
check('API sends security headers and hides X-Powered-By', hh.get('x-content-type-options') === 'nosniff' && hh.get('x-frame-options') === 'DENY' && hh.get('content-security-policy')?.includes("default-src 'none'") && !hh.get('x-powered-by'));
const probe = `probe-${Date.now()}@demo.test`; for (let i = 0; i < 10; i++) await call('POST', '/auth/login', null, { email: probe, password: 'bad' });
const lockd = await call('POST', '/auth/login', null, { email: probe, password: 'bad' });
check('11th failed login -> 429 TOO_MANY_ATTEMPTS with Retry-After', lockd.status === 429 && lockd.body.error.code === 'TOO_MANY_ATTEMPTS' && Number(lockd.headers.get('retry-after')) > 0);
const t1 = await login('member'), t2 = await login('member'); check('fresh tokens work', (await call('GET', '/auth/me', t1)).status === 200);
check('logout -> 204', (await call('POST', '/auth/logout', t1)).status === 204);
check('revoked token is rejected everywhere; the same user\'s other token still works', (await call('GET', '/auth/me', t1)).status === 401 && (await call('GET', '/items', t1)).status === 401 && (await call('GET', '/auth/me', t2)).status === 200);

// --- error handling ---
const bad = await fetch(`${BASE}/api/v1/items`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T.member}` }, body: '{bad json' });
check('malformed JSON -> 400 (not 500)', bad.status === 400, String(bad.status));
check('/health ok', (await fetch(`${BASE}/health`)).status === 200);
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL E2E CHECKS PASSED'); await pool.end(); process.exit(fails ? 1 : 0);
