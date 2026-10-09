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
  daemon, bg          Alias for starting in background (persists across session exit)
  stop                Stop running Orca backend & web client
  restart             Restart Orca backend & web client
  status              Check running status and display pairing information
  logs [-f] [svc]     View service logs (-f to follow; svc: all|orca|web)

Options:
  -d, --daemon, -b, --background
                      Run in background (persists across session exit; default)
  -f, --foreground    Run in foreground (blocks terminal, Ctrl+C to stop)
  --serve-pairing-address <addr>  Set custom pairing address
  --orca-port <port>  Orca WebSocket server port (default: 6768)
  --web-port <port>   Web client HTTP server port (default: 8080)
  -h, --help          Show this help message

Examples:
  $0                                # Start in background (persists after session exit)
  $0 daemon                         # Explicit daemon mode
  $0 192.168.0.22                   # Start with custom pairing address
  $0 status                         # View status & pairing URL anytime
  $0 stop                           # Stop background services
  $0 restart                        # Restart background services
  $0 logs -f                        # Follow service logs
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
    daemon|bg|background)
      ACTION="start"
      FOREGROUND=false
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
    -d|--daemon|-b|--background)
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
  local pattern="${2:-}"
  [ -z "$pid" ] && return 1
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  if [ -n "$pattern" ]; then
    local cmd
    cmd="$(ps -p "$pid" -o cmd= 2>/dev/null || true)"
    if [[ ! "$cmd" =~ $pattern ]]; then
      return 1
    fi
  fi
  return 0
}

is_port_listening() {
  local port="${1:-}"
  [ -z "$port" ] && return 1
  if command -v ss >/dev/null 2>&1; then
    ss -lnt 2>/dev/null | grep -qE ":${port}\b"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lnt 2>/dev/null | grep -qE ":${port}\b"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 0
  fi
}

check_status() {
  local orca_pid=""
  local electron_pid=""
  local http_pid=""
  local orca_alive=false
  local http_alive=false

  if [ -f "$PID_FILE" ]; then
    local cli_pairing="$PAIRING_ADDRESS"
    # shellcheck disable=SC1090
    source "$PID_FILE" 2>/dev/null || true
    if [ -n "$cli_pairing" ]; then
      PAIRING_ADDRESS="$cli_pairing"
    fi
    orca_pid="${ORCA_PID:-}"
    electron_pid="${ELECTRON_PID:-}"
    http_pid="${HTTP_PID:-}"
  fi

  # Check Orca server (electron main process)
  if [ -n "$electron_pid" ] && is_pid_alive "$electron_pid" "index\.js.*--serve"; then
    orca_alive=true
  elif [ -n "$orca_pid" ] && is_pid_alive "$orca_pid"; then
    local detected_electron
    detected_electron="$(pgrep -P "$orca_pid" -f "index\.js.*--serve" 2>/dev/null | head -n1 || true)"
    if [ -n "$detected_electron" ]; then
      electron_pid="$detected_electron"
      orca_alive=true
    elif is_port_listening "$ORCA_SERVE_PORT"; then
      orca_alive=true
    fi
  fi

  if [ "$orca_alive" = false ]; then
    local detected_pid
    detected_pid="$(pgrep -f "$SCRIPT_DIR/out/main/index.js.*--serve" 2>/dev/null | head -n1 || true)"
    if [ -n "$detected_pid" ]; then
      electron_pid="$detected_pid"
      orca_alive=true
    fi
  fi

  # Check Web HTTP server
  if [ -n "$http_pid" ] && is_pid_alive "$http_pid" "start-orca-web-http\.py"; then
    http_alive=true
  else
    local detected_http
    detected_http="$(pgrep -f "start-orca-web-http\.py.*$WEB_SERVE_PORT" 2>/dev/null | head -n1 || true)"
    if [ -n "$detected_http" ]; then
      http_pid="$detected_http"
      http_alive=true
    fi
  fi

  echo "$orca_alive:$http_alive:${electron_pid:-$orca_pid}:$http_pid"
}

print_banner() {
  local pairing_code="${1:-}"
  local pairing_token="${2:-}"
  local web_client_url="${3:-}"
  local host="${PAIRING_ADDRESS:-127.0.0.1}"

  local display_scheme="http"
  local display_host="$host"
  local ws_scheme="ws"

  if [[ "$host" =~ ^https?:// ]]; then
    display_scheme="${host%%://*}"
    display_host="${host#*://}"
    display_host="${display_host%%/*}"
    if [ "$display_scheme" = "https" ]; then
      ws_scheme="wss"
    fi
  fi

  echo ""
  echo "============================================="
  echo "  ORCA WEB CLIENT READY"
  echo "============================================="
  echo ""
  if [ -n "$web_client_url" ]; then
    echo "  Direct Web Client URL (with auto-pairing):"
    echo "    ${web_client_url}"
    echo ""
  fi
  echo "  Access web client (no auto-pairing):"
  if [[ "$host" =~ ^https?:// ]]; then
    echo "    ${host}/web-index.html"
  else
    echo "    http://${host}:${WEB_SERVE_PORT}/web-index.html"
  fi
  echo ""
  if [ -n "$pairing_token" ]; then
    echo "  Connect another Orca client:"
    echo "    Server IP/address: ${display_host}"
    echo "    Access token:      ${pairing_token}"
    echo ""
  fi
  if [ -n "$pairing_code" ]; then
    local encoded_code
    encoded_code="$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$pairing_code" 2>/dev/null || echo "$pairing_code")"
    if [ -z "$web_client_url" ]; then
      echo "  Access web client (with auto-pairing):"
      if [[ "$host" =~ ^https?:// ]]; then
        echo "    ${host}/web-index.html?pairing=orca%3A%2F%2Fpair%3Fcode%3D${encoded_code}"
      else
        echo "    http://${host}:${WEB_SERVE_PORT}/web-index.html?pairing=orca%3A%2F%2Fpair%3Fcode%3D${encoded_code}"
      fi
      echo ""
    fi
    echo "  Or manually enter this pairing code in the web client:"
    echo "    ${pairing_code}"
  fi
  echo ""
  if [[ "$host" =~ ^https?:// ]]; then
    echo "  WebSocket endpoint: ${ws_scheme}://${display_host}"
  else
    echo "  WebSocket endpoint: ws://${host}:${ORCA_SERVE_PORT}"
  fi
  echo ""
  echo "  Log files:"
  echo "    Orca stdout: $ORCA_JSON_LOG"
  echo "    Orca stderr: $ORCA_ERR_LOG"
  echo "    Web server:  $HTTP_LOG"
  echo "============================================="
}

show_status_cmd() {
  if [ -f "$PID_FILE" ]; then
    # shellcheck disable=SC1090
    source "$PID_FILE" 2>/dev/null || true
  fi
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
                print(pairing.get('webClientUrl', ''))
                break
except Exception:
    pass
" 2>/dev/null || true)
      pairing_code="${pairing_values[0]:-}"
      pairing_token="${pairing_values[1]:-}"
      pairing_web_url="${pairing_values[2]:-}"
    fi
    print_banner "$pairing_code" "$pairing_token" "${pairing_web_url:-}"
  else
    echo ""
    echo "Services are not fully running. Start with: $0"
  fi
}

stop_services() {
  echo "[orca] Stopping Orca web services..."
  local stopped=false

  if [ -f "$PID_FILE" ]; then
    local cli_pairing="$PAIRING_ADDRESS"
    # shellcheck disable=SC1090
    source "$PID_FILE" 2>/dev/null || true
    if [ -n "$cli_pairing" ]; then
      PAIRING_ADDRESS="$cli_pairing"
    fi
    if [ -n "${HTTP_PID:-}" ] && is_pid_alive "$HTTP_PID"; then
      kill -TERM -- "-$HTTP_PID" 2>/dev/null || kill "$HTTP_PID" 2>/dev/null || true
      stopped=true
    fi
    if [ -n "${ORCA_PID:-}" ] && is_pid_alive "$ORCA_PID"; then
      kill -TERM -- "-$ORCA_PID" 2>/dev/null || true
      pkill -P "$ORCA_PID" 2>/dev/null || true
      kill "$ORCA_PID" 2>/dev/null || true
      stopped=true
    fi
    if [ -n "${ELECTRON_PID:-}" ] && is_pid_alive "$ELECTRON_PID"; then
      kill "$ELECTRON_PID" 2>/dev/null || true
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

  # Clean up any orphaned Xvfb associated with orca serve
  pkill -f "Xvfb.*1920x1080x24.*nolisten tcp" 2>/dev/null || true

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

  # Clean up any partial or stale lingering instances before starting
  if [ "$orca_alive" = true ] || [ "$http_alive" = true ] || is_port_listening "$ORCA_SERVE_PORT" || is_port_listening "$WEB_SERVE_PORT"; then
    echo "[orca] Detected stale or partially running services/ports. Cleaning up first..."
    stop_services >/dev/null 2>&1 || true
    sleep 0.5
  fi

  # 1) Build check
  if [ ! -f "$SCRIPT_DIR/out/cli/index.js" ] || [ ! -f "$SCRIPT_DIR/out/web/web-index.html" ] || [ ! -f "$SCRIPT_DIR/out/main/index.js" ] || [ ! -f "$SCRIPT_DIR/out/relay/linux-x64/relay.js" ]; then
    echo "Build artifacts missing. Run: pnpm run build:relay && pnpm run build:cli && pnpm run build:electron-vite && pnpm run build:web" >&2
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

  # Check if setsid is available for complete session / TTY detachment
  local bg_prefix=()
  if command -v setsid >/dev/null 2>&1; then
    bg_prefix=("setsid")
  fi

  # 2) Start Orca server in background with xvfb-run (detached session + nohup)
  echo "[orca] Starting Orca server on ws://0.0.0.0:${ORCA_SERVE_PORT} ..."
  # Why: dev-mode Electron's app path can resolve to the Electron binary bundle,
  # so point SSH deploy at this worktree's relay packages explicitly.
  ORCA_RELAY_PATH="$SCRIPT_DIR/out/relay" ORCA_ORCAD_TEMPLATE_PATH="$SCRIPT_DIR/out/orcad-template" "${bg_prefix[@]}" nohup xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
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

  # Detect actual Electron main PID
  ELECTRON_PID="$(pgrep -P "$ORCA_PID" -f "index\.js.*--serve" 2>/dev/null | head -n1 || true)"
  if [ -z "$ELECTRON_PID" ]; then
    ELECTRON_PID="$(pgrep -f "$SCRIPT_DIR/out/main/index.js.*--serve" 2>/dev/null | head -n1 || true)"
  fi

  # 4) Extract pairing credentials
  readarray -t pairing_values < <(echo "$ORCA_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    pairing = data.get('pairing') or {}
    url = pairing.get('url', '')
    print(url.split('code=', 1)[1] if 'code=' in url else '')
    print(pairing.get('token', ''))
    print(pairing.get('webClientUrl', ''))
except Exception:
    print('')
    print('')
    print('')
" 2>/dev/null || true)
  PAIRING_CODE="${pairing_values[0]:-}"
  PAIRING_TOKEN="${pairing_values[1]:-}"
  PAIRING_WEB_URL="${pairing_values[2]:-}"

  # 5) Start HTTP server for web client in background with nohup + setsid
  echo ""
  echo "[web] Starting HTTP server for web client on http://0.0.0.0:${WEB_SERVE_PORT}..."
  "${bg_prefix[@]}" nohup python3 "$SCRIPT_DIR/start-orca-web-http.py" "$WEB_SERVE_PORT" "$SCRIPT_DIR/out/web" \
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
ELECTRON_PID=$ELECTRON_PID
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

  print_banner "$PAIRING_CODE" "$PAIRING_TOKEN" "$PAIRING_WEB_URL"

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
    echo "  [✓] 服务已在后台持续运行 (Orca PID: ${ELECTRON_PID:-$ORCA_PID}, Web PID: ${HTTP_PID})"
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
  local target="all"
  for arg in "$@"; do
    case "$arg" in
      -f|--follow)
        follow=true
        ;;
      orca|server)
        target="orca"
        ;;
      web|http)
        target="web"
        ;;
    esac
  done

  if [ "$follow" = true ]; then
    echo "Tailing logs (Ctrl+C to stop)..."
    case "$target" in
      orca) tail -f "$ORCA_ERR_LOG" 2>/dev/null ;;
      web) tail -f "$HTTP_LOG" 2>/dev/null ;;
      *) tail -f "$ORCA_ERR_LOG" "$HTTP_LOG" 2>/dev/null ;;
    esac
  else
    if [ "$target" = "all" ] || [ "$target" = "orca" ]; then
      echo "=== Orca Server Log (Last 20 lines) ==="
      tail -n 20 "$ORCA_ERR_LOG" 2>/dev/null || echo "(no logs yet)"
      echo ""
    fi
    if [ "$target" = "all" ] || [ "$target" = "web" ]; then
      echo "=== Web HTTP Log (Last 20 lines) ==="
      tail -n 20 "$HTTP_LOG" 2>/dev/null || echo "(no logs yet)"
    fi
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
