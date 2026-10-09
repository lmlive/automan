#!/usr/bin/env bash
# stop-orca-web.sh — Stop running Orca WebSocket server & Web Client

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/start-orca-web.sh" stop "$@"
