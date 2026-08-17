---
type: architecture
title: Deploy Topology
description: Hosts, containers, Cloudflare tunnels, and source trees that make up the CodeForge stage and prod environments on server "miniblack".
tags: [infra, deploy, cloudflare, topology]
timestamp: 2026-07-11T00:00:00Z
---
# Server
Everything runs on one box, ssh alias **`miniblack`**. It hosts BOTH stage and prod.

# Environments
| Env | URL | Containers | Source tree |
|-----|-----|------------|-------------|
| **stage** | stage.gotcode.ai | `codeforge-claude-{backend,frontend,sandbox,db}` | `~/codeforge-stage` |
| **prod** | gotcode.ai | `codeforge-{backend,frontend,sandbox,db}` | `~/codeforge` |

- Images **bake the source at build time** (no source volume mounts) → any code
  change needs a `docker compose build` + recreate, not just a restart.
- DB creds (both): `POSTGRES_USER=codeforge`, `POSTGRES_DB=codeforge`.
- Backend has no healthcheck in compose ("Up", not "(healthy)") — probe
  `http://localhost:8000/health` inside the container instead.
- Migrations run via alembic on backend startup (head `023` as of КАО#R6).

# Source-of-truth git clone
`~/sg1r2/repo` is a real git clone of the repo. Durable deploys sync the plain
(non-git) `~/codeforge*` trees from it — see [Durable deploy](../operations/durable-deploy.md).
**Never overwrite the server `docker-compose.yml` or `.env`** — they hold per-env
secrets not in git.

# Networking — Cloudflare Access tunnels
`ssh miniblack` and both web endpoints ride **cloudflared** tunnels; the box has no
direct public IP.
- `ssh miniblack` → `HostName ssh.vibemessenger.ai`, `ProxyCommand cloudflared access ssh`.
- Other boxes: `miniwhite` (ssh.inscriptio.ai, interactive), `legion` (service-token, non-interactive).

See [cloudflared 530 incident](../operations/incident-cloudflared-530.md) for the
failure mode where the whole box's tunnel drops.

# See also
- [Durable deploy](../operations/durable-deploy.md)
- [cloudflared 530 incident](../operations/incident-cloudflared-530.md)
