# CodeForge Load Tests (k6)

## Install k6
```
# macOS
brew install k6

# Linux
sudo apt install k6  # or download binary from grafana.com/k6

# Windows
choco install k6
```

## Run

### Smoke (10 VUs, 30s)
```
k6 run smoke.js
```

### Read-heavy load (50 VUs, 2 min)
```
BASE_URL=http://localhost:8300 \
TOKEN=xxx \
k6 run read-heavy.js
```

### Stress (ramp 100 VUs, 5 min)
```
k6 run stress.js
```

## Targets
- p95 < 500ms for read endpoints (list sessions, get metrics, dashboard)
- p99 < 2s
- Error rate < 1%
- Throughput > 50 req/s under normal load

## Environment variables
- `BASE_URL` (default http://localhost:8300)
- `TOKEN` (JWT for authenticated endpoints; optional)
