# Security review: authentication and token storage

## What is implemented (verified by tests, the HTTP end-to-end script and the browser check)
- **Passwords:** argon2id. Unknown emails are verified against a dummy hash so response time does not reveal which emails exist.
- **Tokens:** HS256 JWT, 15-minute expiry, algorithm pinned on verify, every token carries a random `jti`. A token without `jti`, signed with another secret or another algorithm is rejected. Roles are read from `memberships` on every request, never from the token, so permission changes apply immediately.
- **Server-side logout:** `POST /auth/logout` stores the token's `jti` in `revoked_tokens` until it would have expired. The auth check (one query) rejects revoked tokens, so a stolen token stops working at logout. Other tokens of the same user are unaffected. Expired revocation rows are purged on each logout.
- **Login throttling:** failed sign-ins are counted per email AND client IP in `login_attempts` (database-backed, so it works across API instances). After 10 failures in a 15-minute window (`LOGIN_MAX_FAILURES`) the API answers `429 TOO_MANY_ATTEMPTS` with `Retry-After`, even for the correct password, before doing any password hashing. Unknown emails are counted too (no account enumeration). A successful login clears the counter. Keying by email+IP means an attacker cannot lock a victim out from another address.
- **API headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cache-Control: no-store`, HSTS when `NODE_ENV=production`, `X-Powered-By` removed.
- **SPA Content-Security-Policy:** production builds contain a CSP `<meta>`: scripts and styles only from the app's own origin, `connect-src` limited to the app origin plus the configured API origin, `object-src 'none'`, `base-uri 'none'`. In a real browser this blocks injected inline script and blocks requests to third-party origins (verified), so a script-injection bug cannot ship the session token to an attacker's server. The nginx image also sends `nosniff`, `X-Frame-Options` and `Referrer-Policy`.
- **Startup guard:** with `NODE_ENV=production` the API refuses to start unless `JWT_SECRET` is at least 32 characters. CORS is an exact-origin allowlist; the API uses a bearer header, not cookies, so classic CSRF does not apply.
- The React app renders user text only through JSX (escaped) and has no `dangerouslySetInnerHTML`.

## What is NOT solved (be honest about these)
- **The token is still in sessionStorage.** The CSP makes exfiltration much harder, but script running inside the app origin (e.g. through a compromised dependency that is part of the bundle) can still read it and call the API as the user. The CSP in a `<meta>` cannot set `frame-ancestors`; send the same policy as an HTTP header from your static host.
- **No refresh token: a session lasts 15 minutes** and then the user must sign in again (the app shows "Your session expired"). This is a real usability cost of keeping the design simple.
- **Throttling is per email+IP, not per account.** A distributed attack using many IPs against one account is not limited per account (deliberately, to avoid lockout-DoS), and password strength is not enforced. `req.ip` is only trustworthy behind a proxy you control: set `TRUST_PROXY` correctly (e.g. `1`), otherwise all users share the proxy's IP or the header is spoofable.
- No MFA, no password reset flow, no audit log of logins, no structured request logging or request IDs, no `helmet`-level coverage beyond the headers above.
- The throttle and revocation tables are only as available as the database; `login_attempts` rows are never purged except by being overwritten after the window.

## Recommended production design (not implemented)
1. **Access token in memory + rotating refresh token in an HttpOnly cookie** (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`), refresh tokens stored hashed server-side with reuse detection (revoke the whole family on replay). This removes the long-lived credential from script reach and ends the 15-minute forced re-login.
2. **CSRF** for the cookie-authenticated refresh/logout endpoints: custom header + `SameSite=Strict` + exact-origin CORS with credentials (never `*`). Item endpoints keep the bearer header.
3. **Same-site hosting** (`app.example.com` + `api.example.com`) so `SameSite=Strict` works; cross-site hosting needs `SameSite=None; Secure` and stronger CSRF tokens.
4. Per-account throttling with exponential backoff and alerting, password policy / breach check, MFA for LEAD and ADMIN, CSP delivered as an HTTP header, structured auth logging, secret rotation (accept old and new signing key during rollover).
