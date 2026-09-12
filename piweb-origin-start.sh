#!/bin/bash
# piweb-origin launcher — starts the pi-web supervisor (which manages BOTH the
# server on :8787 and the `piweb-origin` tunnel, restarting either on crash).
# Idempotent: exits 0 if the supervisor is already running, so it is safe to
# run from `@reboot` cron AND a periodic guard cron. This script does not
# monitor health itself — the supervisor is the watchdog; this only ensures
# the supervisor process exists.
#
# Public URL: https://goyamegh-piweb-origin.c.tunnels.lab.aws.dev
# NOTE: the tunnel needs a valid Midway session. After a long outage run
# `mwinit -o` manually; the supervisor's tunnel retry loop then self-heals.

set -u

APP_DIR=/home/goyamegh/pi-web-origin
PORT=8787
TUNNEL_NAME=piweb-origin
ALLOW_USERS="goyamegh,ashwinpc,kffallis,jadhanir,jasonlh,hellin,nitishg,phaniki,rjthotan,horovits,nsupriy,ymzhang,jenchieu,chclovis,baluta,matcossu,bpavani"
LOG=/tmp/piweb-origin.log
PID_FILE=/tmp/piweb-origin-supervisor.pid

# Resolve tunnel (toolbox) and node/npm (mise shims) from a bare cron env.
#
# IMPORTANT: also include the MCP server shim dirs (~/.aim/mcp-servers,
# ~/.config/smithy-mcp/mcp-servers) and pi's own bin dir. Cron never sources
# ~/.bashrc, which is where these get added for interactive shells — without
# them here, every pi-web session spawned by this supervisor fails ALL
# local-MCP tool calls (Chorus, Slack, Sage+, SharePoint, etc.) with
# `spawn <tool> ENOENT`, silently, for as long as the supervisor stays up
# (hit 2026-09-01: 11 days of every pi-web session unable to reach Chorus/
# Slack because this script's PATH predated the .bashrc MCP shim additions).
export PATH="$HOME/.pi/agent/bin:$HOME/bin:$HOME/.aim/mcp-servers:$HOME/.config/smithy-mcp/mcp-servers:$HOME/.toolbox/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Bedrock credentials for pi's model registry. These live in ~/.zshrc, which
# cron never sources, so a @reboot start came up with no AWS env: pi-web built
# its model list once at boot, found no provider, and served an empty model
# dropdown ("No models available") until manually restarted from a shell.
# No secrets here — the Bedrock profile in ~/.aws/config resolves via ada's
# credential_process, so this only names the profile and region.
export AWS_PROFILE="${AWS_PROFILE:-Bedrock}"
export AWS_REGION="${AWS_REGION:-us-west-2}"
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"

# Singleton: supervisor already running?
if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE" 2>/dev/null)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
fi
# Fallback match in case the pid file was lost
if pgrep -f "tsx supervisor.ts" >/dev/null 2>&1; then
  pgrep -f "tsx supervisor.ts" | head -1 > "$PID_FILE"
  exit 0
fi

# Roll the previous log
[[ -f "$LOG" ]] && mv "$LOG" "${LOG}.$(date -u +%s)" 2>/dev/null

cd "$APP_DIR" || exit 1
setsid bash -c "HOST=127.0.0.1 PORT=${PORT} \
  PI_WEB_TUNNEL_NAME=${TUNNEL_NAME} \
  PI_WEB_TUNNEL_ALLOW='${ALLOW_USERS}' \
  exec node --import tsx supervisor.ts > '$LOG' 2>&1" \
  < /dev/null > /dev/null 2>&1 &
disown || true

# Record the supervisor pid once it appears
for i in $(seq 1 15); do
  sleep 1
  pid=$(pgrep -f "tsx supervisor.ts" | head -1)
  if [[ -n "$pid" ]]; then
    echo "$pid" > "$PID_FILE"
    echo "[piweb-origin-start] $(date -u +%Y-%m-%dT%H:%M:%SZ) supervisor started pid=$pid" >> "$LOG"
    exit 0
  fi
done
echo "[piweb-origin-start] $(date -u +%Y-%m-%dT%H:%M:%SZ) supervisor failed to start" >> "$LOG"
exit 1
