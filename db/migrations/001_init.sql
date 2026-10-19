CREATE TYPE team_role AS ENUM ('VIEWER','MEMBER','LEAD','ADMIN');
CREATE TYPE item_status AS ENUM ('OPEN','IN_PROGRESS','AWAITING_APPROVAL','RESOLVED','CLOSED');
CREATE TYPE item_priority AS ENUM ('LOW','MEDIUM','HIGH','URGENT');
CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE teams (id serial PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE, description text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE memberships (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id), team_id int NOT NULL REFERENCES teams(id), role team_role NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, team_id));
CREATE SEQUENCE item_ref_seq;
CREATE TABLE work_items (
  id serial PRIMARY KEY,
  reference text NOT NULL UNIQUE DEFAULT ('OPS-' || lpad(nextval('item_ref_seq')::text, 5, '0')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200), description text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'TASK', priority item_priority NOT NULL DEFAULT 'MEDIUM', status item_status NOT NULL DEFAULT 'OPEN',
  team_id int NOT NULL REFERENCES teams(id), assignee_id int REFERENCES users(id), created_by_id int NOT NULL REFERENCES users(id),
  due_at timestamptz, version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz);
CREATE INDEX wi_team_status ON work_items(team_id, status, id DESC);
CREATE INDEX wi_assignee ON work_items(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX wi_due ON work_items(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX wi_updated ON work_items(updated_at DESC);
CREATE TABLE activity_events (id bigserial PRIMARY KEY, work_item_id int NOT NULL REFERENCES work_items(id), actor_id int NOT NULL REFERENCES users(id), event_type text NOT NULL, previous_value jsonb, new_value jsonb, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ae_item ON activity_events(work_item_id, id);
CREATE TABLE comments (id serial PRIMARY KEY, work_item_id int NOT NULL REFERENCES work_items(id), author_id int NOT NULL REFERENCES users(id), body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX cm_item ON comments(work_item_id, id);
CREATE TABLE idempotency_records (id serial PRIMARY KEY, key text NOT NULL, actor_id int NOT NULL REFERENCES users(id), scope text NOT NULL, request_hash text NOT NULL, response_status int, response_body jsonb, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours', UNIQUE(actor_id, scope, key));
CREATE TABLE outbox_jobs (id bigserial PRIMARY KEY, event_type text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DONE','FAILED')), attempts int NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, processed_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ob_ready ON outbox_jobs(available_at, id) WHERE status='PENDING';
CREATE TABLE notifications (id bigserial PRIMARY KEY, job_id bigint NOT NULL UNIQUE REFERENCES outbox_jobs(id), message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
