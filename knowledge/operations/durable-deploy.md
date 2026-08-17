---
type: runbook
title: Durable Deploy (stage / prod)
description: How to ship code changes to the stage and prod trees on miniblack so they persist across container recreation, without clobbering server secrets.
tags: [deploy, docker, runbook]
timestamp: 2026-07-11T00:00:00Z
---
# Why "durable"
`docker cp` into a running container is NOT durable — it's lost on recreate. The
durable unit is the **source tree** (`~/codeforge` prod, `~/codeforge-stage` stage),
which the images build from. Land changes in the tree, then rebuild.

# Two ways to get code into the tree
1. **From the git clone** (preferred for committed work): `cd ~/sg1r2/repo && git pull`,
   then sync changed dirs into the target tree, **preserving** `node_modules/`, `dist/`,
   `docker-compose.yml`, `.env`.
2. **Direct file sync** (for uncommitted / surgical changes): `tar` the exact changed
   files locally → `scp` → `tar -xzf` inside the tree. Touches only those files.

# Procedure
1. **Gate (backend only):** confirm 0 live sessions before recreating the backend —
   `docker exec <db> psql -U codeforge -d codeforge -tAc "select count(*) from sessions
   where status in ('running','paused','awaiting_enhancement','enhancing')"`.
   Note: `awaiting_enhancement` is DB-persisted and survives a restart (resumable), so
   an idle one is safe; an actively-`running` one is not.
2. Sync files into the tree (see above).
3. Rebuild only what changed: `docker compose build backend frontend` (sandbox only if
   `sandbox/` changed — its heavy pip layer occasionally fails transiently; just retry).
4. `docker compose up -d --no-deps <services>` to recreate (keeps db up).
5. **Verify:** container `Up`; `/health` inside container = healthy; `alembic current`
   at head; no errors in `docker logs --since 60s`; public URL 200.

# Secrets
- App secrets live in the server `.env` (per-env), NOT in git. To enable a feature that
  needs a key (e.g. `TAVILY_API_KEY`), append it to the target `.env` and recreate the
  backend (`up -d`, which re-injects env; a bare `restart` does not re-read `.env`).
  Copy a value across without printing it: `grep '^KEY=' local.env | tr -d '\r' | ssh
  miniblack 'cat >> ~/codeforge*/.env'`.

# Scope of authority
Deploy to **stage** freely as part of the work. **Commit/push and prod** only on explicit
user request. See [КАО playbook](../conventions/kao-playbook.md).

# See also
- [Deploy topology](../architecture/deploy-topology.md)
- [cloudflared 530 incident](incident-cloudflared-530.md)
