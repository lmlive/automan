#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCA_JSON=""
ORCA_SERVE_PORT=6768
WEB_SERVE_PORT=8080
PAIRING_ADDRESS="${1:-}"

# If a pairing address is provided, set it
EXTRA_ARGS=()
if [ -n "$PAIRING_ADDRESS" ]; then
  EXTRA_ARGS+=("--serve-pairing-address" "$PAIRING_ADDRESS")
fi

CLEANUP_PIDS=()

cleanup() {
  echo ""
  echo "[cleanup] Stopping services..."
  for pid in "${CLEANUP_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "[cleanup] Done."
}
trap cleanup EXIT INT TERM

# 1) build check
if [ ! -f "$SCRIPT_DIR/out/cli/index.js" ] || [ ! -f "$SCRIPT_DIR/out/web/web-index.html" ] || [ ! -f "$SCRIPT_DIR/out/main/index.js" ]; then
  echo "Build artifacts missing. Run: pnpm run build:cli && pnpm run build:electron-vite && pnpm run build:web"
  exit 1
fi

# 2) Start Orca server in background with xvfb-run (handles no-display GPU issues)
echo "[orca] Starting Orca server on ws://0.0.0.0:${ORCA_SERVE_PORT} ..."
xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
  "$SCRIPT_DIR/node_modules/.bin/electron" \
  --no-sandbox \
  "$SCRIPT_DIR/out/main/index.js" \
  --serve --serve-port "$ORCA_SERVE_PORT" --serve-json \
  "${EXTRA_ARGS[@]}" \
  > /tmp/orca-server.json 2>/dev/null &
ORCA_PID=$!
CLEANUP_PIDS+=("$ORCA_PID")

# 3) Wait for the "orca_server_ready" line in output
echo "[orca] Waiting for server ready..."
ORCA_JSON=""
for i in $(seq 1 30); do
  ORCA_JSON="$(grep -o '{"type":"orca_server_ready".*}' /tmp/orca-server.json 2>/dev/null || true)"
  if [ -n "$ORCA_JSON" ]; then
    break
  fi
  sleep 1
done

if [ -z "$ORCA_JSON" ]; then
  echo "[orca] FAILED: Server did not start within 30s. Check /tmp/orca-server.json"
  exit 1
fi

echo "[orca] Server ready!"
echo "$ORCA_JSON" | python3 -m json.tool 2>/dev/null || echo "$ORCA_JSON"

# 4) Extract the pairing code
PAIRING_INFO=$(echo "$ORCA_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(json.dumps(data.get('pairing', {})))
" 2>/dev/null || echo "{}")

PAIRING_CODE=$(echo "$ORCA_JSON" | python3 -c "
import sys, json, urllib.parse
data = json.load(sys.stdin)
pairing = data.get('pairing', {})
url = pairing.get('url', '')
if 'code=' in url:
    code = url.split('code=', 1)[1]
    print(code)
else:
    print('')
" 2>/dev/null || echo "")

echo ""
echo "[web] Starting HTTP server for web client on http://0.0.0.0:${WEB_SERVE_PORT}..."
python3 -m http.server "$WEB_SERVE_PORT" --directory "$SCRIPT_DIR/out/web" &
HTTP_PID=$!
CLEANUP_PIDS+=("$HTTP_PID")
sleep 0.5

echo ""
echo "============================================="
echo "  ORCA WEB CLIENT READY"
echo "============================================="
echo ""
echo "  Access web client (no auto-pairing):"
echo "    http://127.0.0.1:${WEB_SERVE_PORT}/web-index.html"
echo ""
if [ -n "$PAIRING_CODE" ]; then
  ENCODED_CODE=$(python3 -c "
import urllib.parse, sys
print(urllib.parse.quote(sys.argv[1], safe=''))
" "$PAIRING_CODE" 2>/dev/null)
  echo "  Access web client (with auto-pairing):"
  echo "    http://127.0.0.1:${WEB_SERVE_PORT}/web-index.html?pairing=orca%3A%2F%2Fpair%3Fcode%3D${ENCODED_CODE}"
  echo ""
  echo "  Or manually enter this pairing code in the web client:"
  echo "    ${PAIRING_CODE}"
fi
echo ""
echo "  WebSocket endpoint: ws://127.0.0.1:${ORCA_SERVE_PORT}"
echo ""
echo "  Press Ctrl+C to stop all services."
echo "============================================="

# 5) Wait for either process to exit
wait