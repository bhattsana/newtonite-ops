// LOCAL DEMO DATA ONLY. All demo accounts share the password below; never use it anywhere real.
import argon2 from 'argon2';
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== '1') { console.error('Refusing to seed: NODE_ENV=production and ALLOW_SEED is not 1. Seeding WIPES all data.'); process.exit(1); }
import { pool } from './db.js';
const PASSWORD = 'demo-local-only';
const large = process.argv.includes('--large'); const N = large ? 5000 : 48;
await pool.query('TRUNCATE login_attempts,revoked_tokens,notifications,outbox_jobs,idempotency_records,comments,activity_events,work_items,memberships,teams,users RESTART IDENTITY CASCADE');
const hash = await argon2.hash(PASSWORD);
const teams = [['Platform', 'platform', 'Infrastructure and reliability'], ['Support', 'support', 'Customer escalations'], ['Security', 'security', 'Security reviews and incidents']];
for (const [n, s, d] of teams) await pool.query('INSERT INTO teams(name,slug,description) VALUES($1,$2,$3)', [n, s, d]);
// [name, email, [[teamId, role]...]]
const users: [string, string, [number, string][]][] = [
  ['Ada Admin', 'admin@demo.test', [[1, 'ADMIN'], [2, 'ADMIN'], [3, 'ADMIN']]], ['Lena Lead', 'lead@demo.test', [[1, 'LEAD'], [2, 'MEMBER']]],
  ['Sam Support Lead', 'support.lead@demo.test', [[2, 'LEAD']]], ['Maya Member', 'member@demo.test', [[1, 'MEMBER'], [2, 'MEMBER']]],
  ['Omar Member', 'member2@demo.test', [[1, 'MEMBER']]], ['Priya Security', 'security@demo.test', [[3, 'LEAD']]],
  ['Vik Viewer', 'viewer@demo.test', [[1, 'VIEWER'], [2, 'VIEWER']]], ['Nora Newhire', 'nora@demo.test', [[2, 'MEMBER'], [3, 'MEMBER']]],
];
for (const [n, e, ms] of users) {
  const id = (await pool.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id', [n, e, hash])).rows[0].id;
  for (const [t, r] of ms) await pool.query('INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)', [id, t, r]);
}
const members = (await pool.query(`SELECT user_id,team_id,role FROM memberships WHERE role<>'VIEWER' ORDER BY id`)).rows;
const subjects = ['Database failover alert', 'Customer data export stuck', 'Rotate expiring TLS certificates', 'Investigate login latency', 'Refund escalation', 'Review vendor access', 'Disk usage above 85%', 'Webhook retries failing', 'Audit admin permissions', 'Onboarding checklist gaps'];
const statuses = ['OPEN', 'OPEN', 'IN_PROGRESS', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'];
const prios = ['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'URGENT'];
for (let i = 0; i < N; i++) {
  const m = members[i % members.length]; const team = m.team_id;
  const st = statuses[i % statuses.length]; const assigned = st !== 'OPEN' || i % 3 === 0;
  const due = i % 4 === 0 ? `now() - interval '${1 + (i % 5)} days'` : i % 4 === 1 ? `now() + interval '${1 + (i % 9)} days'` : 'NULL';
  const { rows } = await pool.query(
    `INSERT INTO work_items(title,description,priority,type,status,team_id,assignee_id,created_by_id,due_at,resolved_at,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,${due},$9,now() - ($10||' hours')::interval, now() - ($11||' hours')::interval) RETURNING id`,
    [`${subjects[i % subjects.length]}${i >= subjects.length ? ` #${i}` : ''}`, 'Seeded demo item for the local environment.', prios[i % prios.length], i % 2 ? 'INCIDENT' : 'TASK', st, team,
     assigned ? m.user_id : null, m.user_id, ['RESOLVED', 'CLOSED'].includes(st) ? new Date() : null, String(100 + (i % 70)), String(i % 48)]);
  await pool.query(`INSERT INTO activity_events(work_item_id,actor_id,event_type,new_value) VALUES($1,$2,'CREATED','{"seed":true}')`, [rows[0].id, m.user_id]);
  if (i % 5 === 0) {
    await pool.query('INSERT INTO comments(work_item_id,author_id,body) VALUES($1,$2,$3)', [rows[0].id, m.user_id, 'Picking this up; will post findings here.']);
    await pool.query(`INSERT INTO activity_events(work_item_id,actor_id,event_type) VALUES($1,$2,'COMMENTED')`, [rows[0].id, m.user_id]);
  }
}
console.log(`Seeded ${teams.length} teams, ${users.length} users, ${N} items. Demo password: ${PASSWORD}`);
await pool.end();
