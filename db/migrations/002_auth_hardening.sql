-- Failed-login throttling (per email + client IP) and server-side token revocation (logout).
CREATE TABLE login_attempts (key text PRIMARY KEY, failures int NOT NULL, window_start timestamptz NOT NULL DEFAULT now());
CREATE TABLE revoked_tokens (jti text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE INDEX revoked_tokens_expiry ON revoked_tokens(expires_at);
