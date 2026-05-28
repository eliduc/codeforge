# 04 — Security Review Test Spec (Team 1C)

Severities: **Critical** (RCE, auth bypass, data exfil), **High** (privilege escalation, secret leak), **Medium** (XSS, CSRF without sensitive op), **Low** (missing header, info disclosure).

All test endpoints assume base `http://localhost:8000`. Replace `$TOKEN` with a valid Bearer JWT.

---

## SQL Injection

### SEC-001 — Search query SQLi
- How: `GET /sessions?search=%27%20OR%201%3D1--`
- Expected: results filtered as literal string; no full-table dump; no DB error in response body.
- Severity if exposed: **Critical**.

### SEC-002 — Generic string-param SQLi sweep
- How: append `' OR '1'='1` to every string query param across `/sessions`, `/dashboard/*`, `/templates`, `/audits`.
- Expected: 200/400 with normal payload, never 500 with SQL error.
- Severity: **Critical**.

---

## XSS

### SEC-003 — Stored XSS in session name
- How: POST `/sessions` with `name="<script>alert(1)</script>"`. Then GET in UI.
- Expected: name rendered escaped (`&lt;script&gt;`), no script execution. React's default escaping should hold; test any `dangerouslySetInnerHTML`.
- Severity: **Medium**.

### SEC-004 — Stored XSS in specification / custom_prompt
- How: same payload in `specification` and prompt template `content`.
- Expected: rendered escaped on detail page and in graph DetailPanel.
- Severity: **Medium**.

### SEC-005 — Reflected XSS in error message
- How: trigger 400 with `name="<img src=x onerror=alert(1)>"`.
- Expected: backend sanitizes or frontend escapes error string.
- Severity: **Medium**.

---

## CSRF

### SEC-006 — State-changing endpoints require Bearer
- How: POST `/sessions`, `/sessions/{id}/start`, `/sessions/{id}/stop`, DELETE `/sessions/{id}` without `Authorization` header.
- Expected: 401 Unauthorized; no action taken.
- Severity: **Critical**.

### SEC-007 — Cookie auth absence
- Expected: app uses Bearer tokens only; no Set-Cookie session cookies → CSRF surface limited.
- Severity if cookie auth introduced without CSRF token: **High**.

---

## SSRF

### SEC-008 — Fetch-repo URL blocks private IPs
- How: POST `/repos/fetch` body `{ "url": "http://127.0.0.1:8080" }`, also `169.254.169.254` (cloud metadata), `10.0.0.1`, `[::1]`.
- Expected: 400/403 blocked; no outbound connection.
- Severity: **Critical**.

### SEC-009 — list-branches URL same blocklist
- How: same private-IP list against `/repos/branches`.
- Expected: blocked.
- Severity: **High**.

### SEC-010 — Webhook URL private IP
- How: register webhook with `url="http://localhost:9999/foo"`.
- Expected: rejected at registration OR delivery refuses non-public hosts.
- Severity: **High**.

### SEC-011 — DNS rebinding
- How: register webhook with hostname that resolves to public then private IP.
- Expected: per-delivery DNS check; private IP refused.
- Severity: **High**.

---

## Path Traversal

### SEC-012 — File upload traversal
- How: upload filename `../../etc/passwd`.
- Expected: filename normalized; file written under intended dir only.
- Severity: **Critical**.

### SEC-013 — Archive (zip/tar) extraction
- How: zip with entry `../../evil.txt`.
- Expected: extraction rejects or normalizes; nothing written outside extract root.
- Severity: **Critical**.

---

## Authentication / JWT

### SEC-014 — Forged JWT with `alg=none`
- How: craft token header `{"alg":"none","typ":"JWT"}`, no signature.
- Expected: 401. Server rejects `none` and unknown algs.
- Severity: **Critical**.

### SEC-015 — Expired token
- How: token `exp` 1 hour past.
- Expected: 401 with clear "token expired" message.
- Severity: **High**.

### SEC-016 — Missing `exp` claim
- How: token without `exp`.
- Expected: 401 (require exp).
- Severity: **High**.

### SEC-017 — Token signed with wrong secret
- Expected: 401.
- Severity: **Critical**.

### SEC-018 — Cross-user access
- How: user A's token, fetch user B's session by ID.
- Expected: 403/404; no data leak.
- Severity: **Critical**.

---

## Rate Limiting

### SEC-019 — OTP request flood
- How: 50 POSTs to `/auth/otp/send` for one email in 60 s.
- Expected: 429 after threshold; no email storm.
- Severity: **High**.

### SEC-020 — Login attempt brute force
- How: 100 wrong OTP submissions for one email.
- Expected: 429 / lockout after N attempts.
- Severity: **High**.

---

## Secret Leakage

### SEC-021 — API keys in logs
- How: trigger LLM error; grep server logs for `sk-`, `ant-`, etc.
- Expected: keys redacted (`sk-***`).
- Severity: **High**.

### SEC-022 — API keys in error responses
- How: misconfigure provider; observe 500 body.
- Expected: no key in response body.
- Severity: **High**.

### SEC-023 — Telemetry / metrics
- Expected: no secret values in OpenTelemetry spans / Prometheus labels.
- Severity: **High**.

### SEC-024 — Webhook secret never returned
- How: GET `/webhooks/{id}`.
- Expected: `secret` field absent or masked. Only displayed once at creation.
- Severity: **High**.

---

## Webhook Integrity

### SEC-025 — HMAC tampering rejected by receiver-side verification
- How: alter body, keep old signature.
- Expected: documented receiver code verifies and rejects mismatch.
- Severity: **High**.

### SEC-026 — Timing-safe HMAC compare
- How: code review of signature compare.
- Expected: uses `hmac.compare_digest`, not `==`.
- Severity: **Medium**.

---

## Sandbox Escape

### SEC-027 — Filesystem boundary
- How: submit code that writes `/etc/cron.d/x` or reads host `/proc/1/environ`.
- Expected: blocked by sandbox (container/jail). Files invisible.
- Severity: **Critical**.

### SEC-028 — Network egress controls
- How: code attempts to connect to internal `169.254.169.254`.
- Expected: blocked.
- Severity: **Critical**.

### SEC-029 — Resource exhaustion (fork bomb, mem)
- How: `:(){ :|: & };:` or large alloc.
- Expected: killed by cgroup limits within timeout.
- Severity: **High**.

---

## CORS

### SEC-030 — Preflight from disallowed origin
- How: `OPTIONS /sessions` with `Origin: https://evil.example`.
- Expected: no `Access-Control-Allow-Origin: https://evil.example` returned; allowed list enforced.
- Severity: **High**.

### SEC-031 — Wildcard + credentials forbidden
- Expected: never `Access-Control-Allow-Origin: *` together with `Allow-Credentials: true`.
- Severity: **High**.

---

## Security Headers

### SEC-032 — HSTS
- How: `curl -I https://host/`.
- Expected: `Strict-Transport-Security: max-age=…; includeSubDomains`.
- Severity: **Medium**.

### SEC-033 — X-Frame-Options
- Expected: `DENY` or `SAMEORIGIN` (or CSP `frame-ancestors`).
- Severity: **Medium**.

### SEC-034 — X-Content-Type-Options
- Expected: `nosniff`.
- Severity: **Low**.

### SEC-035 — Content-Security-Policy
- Expected: present, no `unsafe-eval`; `unsafe-inline` only if justified.
- Severity: **Medium**.

---

## Client-Side Storage

### SEC-036 — Sensitive data in localStorage
- How: inspect `localStorage` after login.
- Expected: only short-lived auth token (or refresh in HttpOnly cookie); no API keys, no PII beyond email.
- Severity: **High**.

### SEC-037 — Token in URL
- Expected: tokens never appear in query strings (would leak via Referer/logs).
- Severity: **High**.

---

## Open Redirect

### SEC-038 — OAuth/post-login redirect
- How: append `?redirect=https://evil.example` to login flow.
- Expected: only same-origin or allowlisted redirects honored.
- Severity: **Medium**.

---

## Misc

### SEC-039 — Mass assignment
- How: POST `/sessions` with extra field `is_admin=true` or `user_id=<other>`.
- Expected: ignored; pydantic schema rejects unknown or strips.
- Severity: **High**.

### SEC-040 — IDOR on session/audit/webhook IDs
- How: enumerate UUIDs across users.
- Expected: 403/404 unless owner.
- Severity: **Critical**.
