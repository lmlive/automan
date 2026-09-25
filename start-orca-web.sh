#!/usr/bin/env bash
# start-orca-web.sh — Start Orca WebSocket server & Web Client
# Runs in background and detaches from the terminal so closing session/SSH does not kill services.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCA_SERVE_PORT=6768
WEB_SERVE_PORT=8080
PID_FILE="/tmp/orca-web-${UID}.pid"
ORCA_JSON_LOG="/tmp/orca-server.json"
ORCA_ERR_LOG="/tmp/orca-server-err.log"
HTTP_LOG="/tmp/orca-http.log"

ACTION="start"
FOREGROUND=false
PAIRING_ADDRESS=""
EXTRA_ARGS=()

show_help() {
  cat <<EOF
Usage: $0 [ACTION|OPTIONS] [PAIRING_ADDRESS]

Actions:
  start               Start Orca backend & web client in background (default)
  stop                Stop running Orca backend & web client
  restart             Restart Orca backend & web client
  status              Check running status and display pairing information
  logs [-f]           View service logs (-f to follow)

Options:
  -f, --foreground    Run in foreground (blocks terminal, Ctrl+C to stop)
  -d, --daemon        Run in background (persists across session exit; default)
  --serve-pairing-address <addr>  Set custom pairing address
  --orca-port <port>  Orca WebSocket server port (default: 6768)
  --web-port <port>   Web client HTTP server port (default: 8080)
  -h, --help          Show this help message

Examples:
  $0                                # Start in background (persists after session exit)
  $0 192.168.0.22                   # Start with custom pairing address
  $0 status                         # View status & pairing URL anytime
  $0 stop                           # Stop background services
  $0 -f                             # Run in foreground for debugging
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    start)
      ACTION="start"
      shift
      ;;
    stop|--stop)
      ACTION="stop"
      shift
      ;;
    restart|--restart)
      ACTION="restart"
      shift
      ;;
    status|--status)
      ACTION="status"
      shift
      ;;
    logs|--logs)
      ACTION="logs"
      shift
      ;;
    -f|--foreground)
      FOREGROUND=true
      shift
      ;;
    -d|--daemon)
      FOREGROUND=false
      shift
      ;;
    --serve-pairing-address)
      if [[ $# -gt 1 ]]; then
        PAIRING_ADDRESS="$2"
        shift 2
      else
        echo "Error: --serve-pairing-address requires an argument" >&2
        exit 1
      fi
      ;;
    --orca-port)
      if [[ $# -gt 1 ]]; then
        ORCA_SERVE_PORT="$2"
        shift 2
      else
        echo "Error: --orca-port requires a port argument" >&2
        exit 1
      fi
      ;;
    --web-port)
      if [[ $# -gt 1 ]]; then
        WEB_SERVE_PORT="$2"
        shift 2
      else
        echo "Error: --web-port requires a port argument" >&2
        exit 1
      fi
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      if [[ -z "$PAIRING_ADDRESS" && "$1" != -* ]]; then
        PAIRING_ADDRESS="$1"
        shift
      else
        EXTRA_ARGS+=("$1")
        shift
      fi
      ;;
  esac
done

is_pid_alive() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

check_status() {
  local orca_pid=""
  local http_pid=""
  local orca_alive=false
  local http_alive=false

  if [ -f "$PID_FILE" ]; then
    # shellcheck disable=SC1090
    source "$PID_FILE" 2>/dev/null || true
    orca_pid="${ORCA_PID:-}"
    http_pid="${HTTP_PID:-}"
  fi

  if is_pid_alive "$orca_pid"; then
    orca_alive=true
  else
    local detected_pid
    detected_pid="$(pgrep -f "$SCRIPT_DIR/out/main/index.js.*--serve" 2>/dev/null | head -n1 || true)"
    if [ -n "$detected_pid" ]; then
      orca_pid="$detected_pid"
      orca_alive=true
    fi
  fi

  if is_pid_alive "$http_pid"; then
    http_alive=true
  else
    local detected_pid
    detected_pid="$(pgrep -f "start-orca-web-http.py.*$WEB_SERVE_PORT" 2>/dev/null | head -n1 || true)"
    if [ -n "$detected_pid" ]; then
      http_pid="$detected_pid"
      http_alive=true
    fi
  fi

  echo "$orca_alive:$http_alive:$orca_pid:$http_pid"
}

print_banner() {
  local pairing_code="${1:-}"
  local pairing_token="${2:-}"
  local host="${PAIRING_ADDRESS:-127.0.0.1}"

  echo ""
  echo "============================================="
  echo "  ORCA WEB CLIENT READY"
  echo "============================================="
  echo ""
  echo "  Access web client (no auto-pairing):"
  echo "    http://${host}:${WEB_SERVE_PORT}/web-index.html"
  echo ""
  if [ -n "$pairing_token" ]; then
    echo "  Connect another Orca client:"
    echo "    Server IP/address: ${host}"
    echo "    Access token:      ${pairing_token}"
    echo ""
  fi
  if [ -n "$pairing_code" ]; then
    local encoded_code
    encoded_code="$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$pairing_code" 2>/dev/null || echo "$pairing_code")"
    echo "  Access web client (with auto-pairing):"
    echo "    http://${host}:${WEB_SERVE_PORT}/web-index.html?pairing=orca%3A%2F%2Fpair%3Fcode%3D${encoded_code}"
    echo ""
    echo "  Or manually enter this pairing code in the web client:"
    echo "    ${pairing_code}"
  fi
  echo ""
  echo "  WebSocket endpoint: ws://${host}:${ORCA_SERVE_PORT}"
  echo ""
  echo "  Log files:"
  echo "    Orca stdout: $ORCA_JSON_LOG"
  echo "    Orca stderr: $ORCA_ERR_LOG"
  echo "    Web server:  $HTTP_LOG"
  echo "============================================="
}

show_status_cmd() {
  local status_info
  status_info="$(check_status)"
  local orca_alive="${status_info%%:*}"
  local rest="${status_info#*:}"
  local http_alive="${rest%%:*}"
  rest="${rest#*:}"
  local orca_pid="${rest%%:*}"
  local http_pid="${rest#*:}"

  echo "=== Orca Web Service Status ==="
  if [ "$orca_alive" = true ]; then
    echo "  Orca WebSocket Server : RUNNING (PID: $orca_pid, Port: $ORCA_SERVE_PORT)"
  else
    echo "  Orca WebSocket Server : STOPPED"
  fi

  if [ "$http_alive" = true ]; then
    echo "  Web HTTP Client Server: RUNNING (PID: $http_pid, Port: $WEB_SERVE_PORT)"
  else
    echo "  Web HTTP Client Server: STOPPED"
  fi

  if [ "$orca_alive" = true ] && [ "$http_alive" = true ]; then
    local pairing_code=""
    local pairing_token=""
    if [ -f "$ORCA_JSON_LOG" ]; then
      readarray -t pairing_values < <(python3 -c "
import json
try:
    with open('$ORCA_JSON_LOG') as f:
        for line in f:
            if 'orca_server_ready' in line:
                data = json.loads(line.strip())
                pairing = data.get('pairing') or {}
                url = pairing.get('url', '')
                print(url.split('code=', 1)[1] if 'code=' in url else '')
                print(pairing.get('token', ''))
                break
except Exception:
    pass
" 2>/dev/null || true)
      pairing_code="${pairing_values[0]:-}"
      pairing_token="${pairing_values[1]:-}"
    fi
    print_banner "$pairing_code" "$pairing_token"
  else
    echo ""
    echo "Services are not fully running. Start with: $0"
  fi
}

stop_services() {
  echo "[orca] Stopping Orca web services..."
  local stopped=false

  if [ -f "$PID_FILE" ]; then
    # shellcheck disable=SC1090
    source "$PID_FILE" 2>/dev/null || true
    if [ -n "${HTTP_PID:-}" ] && is_pid_alive "$HTTP_PID"; then
      kill "$HTTP_PID" 2>/dev/null || true
      stopped=true
    fi
    if [ -n "${ORCA_PID:-}" ] && is_pid_alive "$ORCA_PID"; then
      pkill -P "$ORCA_PID" 2>/dev/null || true
      kill "$ORCA_PID" 2>/dev/null || true
      stopped=true
    fi
    rm -f "$PID_FILE"
  fi

  # Also terminate by process name in case PIDs changed or orphaned
  pkill -f "$SCRIPT_DIR/out/main/index.js.*--serve" 2>/dev/null && stopped=true || true
  pkill -f "start-orca-web-http.py.*$WEB_SERVE_PORT" 2>/dev/null && stopped=true || true

  # Grace period: wait up to 3 seconds for clean exit
  for _ in {1..15}; do
    if ! pgrep -f "$SCRIPT_DIR/out/main/index.js.*--serve" >/dev/null 2>&1 && \
       ! pgrep -f "start-orca-web-http.py.*$WEB_SERVE_PORT" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done

  # Force kill if still lingering
  pkill -9 -f "$SCRIPT_DIR/out/main/index.js.*--serve" 2>/dev/null || true
  pkill -9 -f "start-orca-web-http.py.*$WEB_SERVE_PORT" 2>/dev/null || true

  if [ "$stopped" = true ]; then
    echo "[orca] Services stopped successfully."
  else
    echo "[orca] No running Orca web services found."
  fi
}

start_services() {
  local status_info
  status_info="$(check_status)"
  local orca_alive="${status_info%%:*}"
  local rest="${status_info#*:}"
  local http_alive="${rest%%:*}"
  rest="${rest#*:}"
  local orca_pid="${rest%%:*}"
  local http_pid="${rest#*:}"

  if [ "$orca_alive" = true ] && [ "$http_alive" = true ]; then
    echo "[orca] Orca web services are already running! (Orca PID: $orca_pid, Web PID: $http_pid)"
    show_status_cmd
    echo ""
    echo "Tip: run '$0 restart' to restart, or '$0 stop' to stop."
    return 0
  fi

  # 1) Build check
  if [ ! -f "$SCRIPT_DIR/out/cli/index.js" ] || [ ! -f "$SCRIPT_DIR/out/web/web-index.html" ] || [ ! -f "$SCRIPT_DIR/out/main/index.js" ]; then
    echo "Build artifacts missing. Run: pnpm run build:cli && pnpm run build:electron-vite && pnpm run build:web" >&2
    exit 1
  fi

  if [ -n "$PAIRING_ADDRESS" ]; then
    EXTRA_ARGS+=("--serve-pairing-address" "$PAIRING_ADDRESS")
  fi

  # Clear old logs
  rm -f "$ORCA_JSON_LOG" "$ORCA_ERR_LOG" "$HTTP_LOG"
  touch "$ORCA_ERR_LOG" "$HTTP_LOG"

  STARTUP_PIDS=()
  abort_startup() {
    echo ""
    echo "[orca] Startup interrupted or failed. Cleaning up..."
    for pid in "${STARTUP_PIDS[@]}"; do
      if [ -n "$pid" ] && is_pid_alive "$pid"; then
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
      fi
    done
    rm -f "$PID_FILE"
    exit 1
  }
  trap abort_startup INT TERM

  # 2) Start Orca server in background with xvfb-run (nohup protects from SIGHUP on session close)
  echo "[orca] Starting Orca server on ws://0.0.0.0:${ORCA_SERVE_PORT} ..."
  nohup xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
    "$SCRIPT_DIR/node_modules/.bin/electron" \
    --no-sandbox \
    "$SCRIPT_DIR/out/main/index.js" \
    --serve --serve-port "$ORCA_SERVE_PORT" --serve-json \
    "${EXTRA_ARGS[@]}" \
    > "$ORCA_JSON_LOG" 2> "$ORCA_ERR_LOG" < /dev/null &
  ORCA_PID=$!
  STARTUP_PIDS+=("$ORCA_PID")

  # 3) Wait for the "orca_server_ready" line in output
  echo "[orca] Waiting for server ready..."
  ORCA_JSON=""
  for _ in $(seq 1 30); do
    if ! is_pid_alive "$ORCA_PID"; then
      echo "[orca] ERROR: Orca server process died during startup. Check $ORCA_ERR_LOG:" >&2
      tail -n 20 "$ORCA_ERR_LOG" >&2 || true
      abort_startup
    fi
    ORCA_JSON="$(grep -o '{"type":"orca_server_ready".*}' "$ORCA_JSON_LOG" 2>/dev/null || true)"
    if [ -n "$ORCA_JSON" ]; then
      break
    fi
    sleep 1
  done

  if [ -z "$ORCA_JSON" ]; then
    echo "[orca] FAILED: Server did not start within 30s. Check $ORCA_JSON_LOG and $ORCA_ERR_LOG" >&2
    abort_startup
  fi

  echo "[orca] Server ready!"

  # 4) Extract pairing credentials
  readarray -t pairing_values < <(echo "$ORCA_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    pairing = data.get('pairing') or {}
    url = pairing.get('url', '')
    print(url.split('code=', 1)[1] if 'code=' in url else '')
    print(pairing.get('token', ''))
except Exception:
    print('')
    print('')
" 2>/dev/null || true)
  PAIRING_CODE="${pairing_values[0]:-}"
  PAIRING_TOKEN="${pairing_values[1]:-}"

  # 5) Start HTTP server for web client in background with nohup
  echo ""
  echo "[web] Starting HTTP server for web client on http://0.0.0.0:${WEB_SERVE_PORT}..."
  nohup python3 "$SCRIPT_DIR/start-orca-web-http.py" "$WEB_SERVE_PORT" "$SCRIPT_DIR/out/web" \
    > "$HTTP_LOG" 2>&1 < /dev/null &
  HTTP_PID=$!
  STARTUP_PIDS+=("$HTTP_PID")
  sleep 0.5

  if ! is_pid_alive "$HTTP_PID"; then
    echo "[web] ERROR: Web HTTP server failed to start. Check $HTTP_LOG" >&2
    abort_startup
  fi

  # Record PIDs and configuration to PID_FILE
  cat <<EOF > "$PID_FILE"
ORCA_PID=$ORCA_PID
HTTP_PID=$HTTP_PID
ORCA_SERVE_PORT=$ORCA_SERVE_PORT
WEB_SERVE_PORT=$WEB_SERVE_PORT
PAIRING_ADDRESS=$PAIRING_ADDRESS
EOF

  # Disown background processes so closing terminal / SSH session won't kill them
  disown "$ORCA_PID" 2>/dev/null || true
  disown "$HTTP_PID" 2>/dev/null || true

  # Remove abort trap so script exit does not kill the running services
  trap - INT TERM

  print_banner "$PAIRING_CODE" "$PAIRING_TOKEN"

  if [ "$FOREGROUND" = true ]; then
    echo "  [运行模式: 前台运行 (按 Ctrl+C 停止所有服务)]"
    echo "============================================="
    fg_cleanup() {
      echo ""
      stop_services
      exit 0
    }
    trap fg_cleanup INT TERM
    wait "$ORCA_PID" "$HTTP_PID" 2>/dev/null || true
  else
    echo "  [✓] 服务已在后台持续运行 (Orca PID: ${ORCA_PID}, Web PID: ${HTTP_PID})"
    echo "  [✓] 关闭当前终端/Session 不会影响后台服务运行"
    echo ""
    echo "  常用管理命令:"
    echo "    查看状态与配对码: $0 status"
    echo "    停止后台服务:     $0 stop"
    echo "    重启后台服务:     $0 restart"
    echo "    查看实时日志:     $0 logs -f"
    echo "============================================="
  fi
}

show_logs() {
  local follow=false
  for arg in "$@"; do
    if [ "$arg" = "-f" ] || [ "$arg" = "--follow" ]; then
      follow=true
    fi
  done

  if [ "$follow" = true ]; then
    echo "Tailing logs (Ctrl+C to stop)..."
    tail -f "$ORCA_ERR_LOG" "$HTTP_LOG" 2>/dev/null
  else
    echo "=== Orca Server Log (Last 20 lines) ==="
    tail -n 20 "$ORCA_ERR_LOG" 2>/dev/null || echo "(no logs yet)"
    echo ""
    echo "=== Web HTTP Log (Last 20 lines) ==="
    tail -n 20 "$HTTP_LOG" 2>/dev/null || echo "(no logs yet)"
  fi
}

case "$ACTION" in
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  restart)
    stop_services
    sleep 1
    start_services
    ;;
  status)
    show_status_cmd
    ;;
  logs)
    show_logs "$@"
    ;;
  *)
    show_help
    exit 1
    ;;
esac
