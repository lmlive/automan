#!/usr/bin/env bash
# dispatch-workers.sh — boot one headless agent per dispatched task, reactively.
#
# DESIGN: do NOT race the coordinator. The coordinator owns dispatching — each
# tick it grabs ready tasks (db.listTasks ready) and calls createTerminal +
# dispatchContext for them, marking the task `dispatched`. Two things happen:
#
#   1. A worker terminal exists (created by the coordinator), and a real
#      dispatch_context row exists in the DB.
#   2. The terminal has the preamble + task text injected *by the coordinator*,*
#      but no agent process is running in it yet — that's the gap this fills.
#
# So we never call task-update / dispatch / dispatch-context ourselves. We poll
# `task-list --status dispatched` and, for any dispatched task that does NOT yet
# have a live agent we launched for it, we call `dispatch-worker.sh --task <id>`
# (which internally uses read-only `dispatch-show --preamble` and reuses the
# real dispatch_context.id). If the same task gets re-dispatched after a circuit
# break, dispatch-show returns the NEW ctx.id; our previous process for this
# task should already have exited (worker_done or failure), so we relaunch.
#
# Concurrency: the coordinator already caps in-flight tasks via --max-concurrent.
# We additionally cap with --max-workers (default = that same number) so we
# don't oversubscribe cores on the box launching agents.
#
# Usage:
#   ./dispatch-workers.sh [--max-workers N] [--poll-seconds S] [--agent 'claude ...']
#   Run AFTER decompose-and-run.sh has started a coordinator. Ctrl-C to stop
#   launching new workers; already-running workers continue until they exit.
#
# Env:
#   ORCA         orca/orca-dev binary (passed through to dispatch-worker.sh)
#   AGENT        agent launch command (passed through; dispatch-worker.sh default
#                is 'claude'). Don't set --dangerously-skip-permissions
#                implicitly; opt in explicitly only if you accept the risk.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCA="${ORCA:-orca}"
WORKER="${HERE}/dispatch-worker.sh"
MAX_WORKERS=3
POLL_SECONDS=2

err() { printf '✖ %s\n' "$*" >&2; }
log() { printf '• %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-workers)    MAX_WORKERS="$2";    shift 2 ;;
    --poll-seconds)   POLL_SECONDS="$2";   shift 2 ;;
    --agent)          AGENT_OVERRIDE="$2";  shift 2 ;;
    -h|--help)
      grep -E '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown flag: $1"; exit 1 ;;
  esac
done

# Track live worker PIDs by task id so we don't double-launch, and so Ctrl-C is
# clean (we exit the launcher; running agents keep going and self-report).
declare -A LIVE_PIDS=()

cleanup() { log "launcher stopping (running workers continue)."; exit 0; }
trap cleanup INT TERM

log "workers: max=${MAX_WORKERS}  poll=${POLL_SECONDS}s  worker=${WORKER}"
log "Ctrl-C stops launching; already-running agents finish and self-report."

while true; do
  # Fail soft: a transient RPC error must not kill the launcher.
  DISPATCHED="$("${ORCA}" orchestration task-list --status dispatched --json 2>/dev/null || echo '{"tasks":[]}')"
  TASK_IDS="$(printf '%s' "$DISPATCHED" | jq -r '.tasks[].id' 2>/dev/null || true)"

  # Reap finished children so LIVE_PIDS stays accurate.
  for tid in "${!LIVE_PIDS[@]}"; do
    if ! kill -0 "${LIVE_PIDS[$tid]}" 2>/dev/null; then
      log "  worker for ${tid} exited (pid ${LIVE_PIDS[$tid]})"
      unset 'LIVE_PIDS[$tid]'
    fi
  done

  for tid in $TASK_IDS; do
    # Already staffing this task? skip.
    [[ -n "${LIVE_PIDS[$tid]:-}" ]] && continue
    (( ${#LIVE_PIDS[@]} >= MAX_WORKERS )) && break

    log "launching worker for dispatched task ${tid}"
    # Pass-through AGENT override. launch in background; dispatch-worker.sh
    # itself execs the agent, so the agent IS this PID.
    ( export ORCA
      [[ -n "${AGENT_OVERRIDE:-}" ]] && export AGENT="$AGENT_OVERRIDE"
      "${WORKER}" --task "${tid}"
    ) &
    LIVE_PIDS[$tid]=$!
  done

  # Exit when the run is fully terminal AND nothing is left to launch.
  TOTAL="$(printf '%s' "$DISPATCHED" | jq -r '.tasks|length' 2>/dev/null || echo 0)"
  if [[ "$TOTAL" == "0" && ${#LIVE_PIDS[@]} -eq 0 ]]; then
    # Confirm the whole run reached terminal — another status could still be
    # inflight (pending). Only exit when nothing dispatched and nothing live.
    PENDING="$("${ORCA}" orchestration task-list --json 2>/dev/null || echo '{"tasks":[]}')"
    if ! printf '%s' "$PENDING" | jq -e '.tasks|any(.status=="pending" or .status=="ready" or .status=="dispatched")' >/dev/null 2>&1; then
      log "no dispatched/pending/ready tasks remain — run converged."
      break
    fi
  fi

  sleep "$POLL_SECONDS"
done

log "launcher done."
