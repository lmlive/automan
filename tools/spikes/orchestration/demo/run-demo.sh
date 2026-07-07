#!/usr/bin/env bash
# run-demo.sh — end-to-end smoke test of the orchestration wrappers with NO LLM.
#
# It spins up a throwaway git repo + worktree, runs decompose-and-run.sh with
# fake-decompose.sh, then dispatch-workers.sh with fake-agent.sh, waits for
# convergence, and runs finalize-verify.sh. Total runtime: seconds. Nothing
# leaves the temp dir.
#
# Preconditions: `orca` (or set ORCA=orca-dev) must resolve and its runtime must
# be running (Orca desktop app / dev runtime). The wrappers and demo scripts
# must be executable (this script chmod's them if needed).
#
# Usage:   ./run-demo.sh
# Cleanup: rm -rf /tmp/orca-orch-demo OR remove the scratch repo entirely.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORK="$(cd "$HERE/.." && pwd)"

ORCA="${ORCA:-orca}"

ROOT="/tmp/orca-orch-demo"
REPO="$ROOT/myrepo"
WT="$ROOT/myrepo-auth"
BRANCH="feat/orcha-demo"

log() { printf '• %s\n' "$*" >&2; }
err() { printf '✖ %s\n' "$*" >&2; }

chmod +x "$ORK/decompose-and-run.sh" "$ORK/dispatch-worker.sh" \
         "$ORK/dispatch-workers.sh" "$ORK/finalize-verify.sh" \
         "$HERE/fake-agent.sh" "$HERE/fake-decompose.sh" 2>/dev/null || true

# ── Scratch repo + worktree. ────────────────────────────────────────────────
log "setting up scratch git repo at ${ROOT}"
rm -rf "$ROOT"
mkdir -p "$ROOT"
git -C "$ROOT" init -q -b main "$REPO" >/dev/null
git -C "$REPO" config user.email demo@orca.dev
git -C "$REPO" config user.name demo
git -C "$REPO" commit -q --allow-empty -m "initial"
git -C "$REPO" worktree add -q -b "$BRANCH" "$WT" >/dev/null
git -C "$WT" config user.email demo@orca.dev
git -C "$WT" config user.name demo
log "worktree: ${WT} on branch ${BRANCH}"

# A worktree selector that the runtime can resolve is the coordinator's
# --worktree. The hostname-label form below is a best-effort; if your runtime
# can't resolve it, the drift guard logs "inert" and dispatch proceeds — fine
# for a smoke test (no real upstream to drift behind).
WORKTREE_SELECTOR="$WT"

# ── 1. Decompose + start coordinator (fake-decompose emits a fixed DAG). ───
log "[1/3] decompose-and-run.sh (DECOMPOSE_CMD=fake-decompose.sh)"
DECOMPOSE_CMD="$HERE/fake-decompose.sh" \
  "$ORK/decompose-and-run.sh" "Demo: refactor auth (login API + UI + E2E)" \
    "$WORKTREE_SELECTOR" 3
# (this script returns immediately; the coordinator loop runs in the runtime)

# ── 2. Launch workers with the fake agent. ──────────────────────────────────
log "[2/3] dispatch-workers.sh (AGENT=fake-agent.sh)"
# Pass our fake agent through. --max-workers 3 to match --max-concurrent 3.
AGENT="$HERE/fake-agent.sh" "$ORK/dispatch-workers.sh" \
  --max-workers 3 --poll-seconds 2

# ── 3. End-of-run report. ────────────────────────────────────────────────────
log "[3/3] finalize-verify.sh"
"$ORK/finalize-verify.sh" "$WT"

log "demo done. scratch dir left at ${ROOT}; remove with: rm -rf ${ROOT}"
