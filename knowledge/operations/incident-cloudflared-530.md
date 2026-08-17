---
type: runbook
title: Incident — Cloudflare 530 / SSH websocket handshake
description: How to recognise and triage the failure where stage and prod both go down because miniblack's Cloudflare tunnel/connector (not the code) is down.
tags: [incident, cloudflare, ssh, outage]
timestamp: 2026-07-11T00:00:00Z
---
# Symptom
- `ssh miniblack` fails with `websocket: bad handshake`, AND
- `https://gotcode.ai/` and `https://stage.gotcode.ai/` both return **HTTP 530**
  (Cloudflare "origin unreachable").

# Diagnosis
Both web endpoints and ssh reach miniblack through Cloudflare tunnels. 530 everywhere +
ssh handshake failure = **the miniblack box or its `cloudflared` connector is down** —
NOT the application code. Cloudflare's edge is fine; the origin/connector is the failure.

# Triage (isolate it)
Test other hosts that use the SAME cloudflared mechanism:
- `ssh miniwhite 'echo ok'` (ssh.inscriptio.ai, interactive Access)
- `ssh legion 'echo ok'` (service-token, non-interactive)

If miniwhite/legion connect but miniblack doesn't, the fault is **miniblack-specific**
(its box/connector), not your local cloudflared client or Cloudflare Access login.

# Resolution (server-side only)
No remote path exists while miniblack's tunnel is down — all agent access rides that
tunnel. The owner must restore it: power/reboot the box, or restart the connector on it
(`systemctl restart cloudflared`). Once the tunnel is back, `ssh` and the sites recover.

# Notes
- Containers usually survive (they come back `Up`); DB-persisted sessions (e.g.
  `awaiting_enhancement`) survive too.
- Observed live 2026-07-11: full outage mid-session while miniwhite/legion stayed up;
  recovered when the owner brought the connector back.

# See also
- [Deploy topology](../architecture/deploy-topology.md)
