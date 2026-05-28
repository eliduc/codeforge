#!/bin/bash
# =============================================================================
# Server Watchdog — checks and restarts all services every 5 minutes
# Covers: cloudflared, CodeForge (prod+stage), VibeMessenger (prod+stage)
# Install: crontab -e → */5 * * * * /home/lev/watchdog.sh >> /var/log/watchdog.log 2>&1
# =============================================================================

LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"
RESTART_NEEDED=0

log()   { echo "$LOG_PREFIX $1"; }
warn()  { echo "$LOG_PREFIX WARNING: $1"; }
fix()   { echo "$LOG_PREFIX FIX: $1"; RESTART_NEEDED=1; }

# ---------------------------------------------------------------------------
# 1. cloudflared tunnel
# ---------------------------------------------------------------------------
if systemctl is-active --quiet cloudflared; then
    : # ok
else
    warn "cloudflared is not running"
    fix "Starting cloudflared..."
    sudo systemctl start cloudflared
    sleep 3
    if systemctl is-active --quiet cloudflared; then
        log "cloudflared started OK"
    else
        warn "cloudflared FAILED to start"
    fi
fi

# ---------------------------------------------------------------------------
# 2. Docker daemon
# ---------------------------------------------------------------------------
if ! docker ps &>/dev/null; then
    warn "Docker daemon is not running"
    fix "Starting Docker..."
    sudo systemctl start docker
    sleep 5
    if ! docker ps &>/dev/null; then
        warn "Docker FAILED to start — aborting"
        exit 1
    fi
    log "Docker started OK"
fi

# ---------------------------------------------------------------------------
# Helper: check and start a docker-compose project
# Args: $1=project_dir $2=project_name $3=required_containers (space-separated)
# ---------------------------------------------------------------------------
check_project() {
    local dir="$1"
    local name="$2"
    shift 2
    local containers=("$@")

    if [ ! -d "$dir" ]; then
        warn "$name: directory $dir not found"
        return
    fi

    local need_up=0
    for c in "${containers[@]}"; do
        local status
        status=$(docker inspect --format '{{.State.Status}}' "$c" 2>/dev/null)
        if [ "$status" != "running" ]; then
            warn "$name: container $c is '$status' (expected 'running')"
            need_up=1
        fi
    done

    if [ $need_up -eq 1 ]; then
        fix "$name: bringing up containers..."
        cd "$dir" && docker compose up -d 2>&1 | while read -r line; do log "  $line"; done
        sleep 5

        # Verify
        local still_bad=0
        for c in "${containers[@]}"; do
            local status
            status=$(docker inspect --format '{{.State.Status}}' "$c" 2>/dev/null)
            if [ "$status" != "running" ]; then
                warn "$name: container $c still not running after restart ($status)"
                still_bad=1
            fi
        done
        if [ $still_bad -eq 0 ]; then
            log "$name: all containers running OK"
        fi
    fi
}

# ---------------------------------------------------------------------------
# 3. CodeForge Prod
# ---------------------------------------------------------------------------
check_project /home/lev/codeforge "CodeForge-Prod" \
    codeforge-db codeforge-backend codeforge-frontend codeforge-sandbox

# ---------------------------------------------------------------------------
# 4. CodeForge Stage
# ---------------------------------------------------------------------------
check_project /home/lev/codeforge-stage "CodeForge-Stage" \
    codeforge-stage-db codeforge-stage-backend codeforge-stage-frontend codeforge-stage-sandbox

# ---------------------------------------------------------------------------
# 5. VibeMessenger Prod
# ---------------------------------------------------------------------------
check_project /home/lev/vibemessenger-prod "VibeMsgr-Prod" \
    messenger-db messenger-api messenger-nginx

# ---------------------------------------------------------------------------
# 6. VibeMessenger Stage
# ---------------------------------------------------------------------------
check_project /home/lev/vibemessenger-stage "VibeMsgr-Stage" \
    messenger-db-stage messenger-api-stage messenger-nginx-stage

# ---------------------------------------------------------------------------
# 7. Port health checks (verify services are actually listening)
# ---------------------------------------------------------------------------
check_port() {
    local port="$1"
    local name="$2"
    if ! ss -tlnp 2>/dev/null | grep -q ":${port} "; then
        warn "$name: port $port not listening"
    fi
}

check_port 3000  "CodeForge-Prod-Frontend"
check_port 3100  "CodeForge-Stage-Frontend"
check_port 8000  "CodeForge-Prod-Backend"
check_port 8100  "CodeForge-Stage-Backend"
check_port 7443  "VibeMsgr-Prod-Nginx"
check_port 7444  "VibeMsgr-Stage-Nginx"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [ $RESTART_NEEDED -eq 0 ]; then
    : # All quiet — no output to keep log clean
else
    log "Watchdog run complete — fixes were applied"
fi
