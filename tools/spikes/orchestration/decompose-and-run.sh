#!/usr/bin/env bash
# Decompose a request into an orchestration task DAG and start the coordinator.
#
# Why: Orca's coordinator does NOT auto-decompose (orchestration/coordinator.ts:
# "AI-driven decomposition belongs in a future phase where the coordinator
# itself is an LLM agent"). This script supplies the missing brain: an LLM
# produces a task list, we persist them as orchestration tasks with real deps
# — which must be a JSON array of *existing* task IDs (no placeholder syntax is
# supported by TaskCreateParams) — so we create tasks in **topological order**:
# every dep referenced by "#n" already exists with a resolved id by the time we
# build its owner. `task-update` can only set status/result, never deps, so a
# topological creation order is the only single-pass correct path.
#
# Then we hand the built DAG to `orca orchestration run`, which the coordinator
# picks up and schedules (drift guarded via --worktree, concurrency capped
# --max-concurrent, polled every 2s).
#
# Usage:
#   ./decompose-and-run.sh "<high-level request>" <worktree-selector> [n_concurrent]
#
# Env:
#   ORCA          orca/orca-dev binary            (default: from PATH)
#   DECOMPOSE_CMD shell command that reads a request on argv and prints
#                 a JSON array [{spec,task_title,deps:["#1",...]}] on stdout.
#                 default: `claude --print`
#                 NOTE: do NOT hardcode --dangerously-skip-permissions here.
#                 Per-action approval is Orca's safety contract; opt into
#                 skip-permissions explicitly only if you accept that risk.
#   DRY_RUN=1     decompose + print the plan, do not create tasks or run.
#   POLL          if set (e.g. POLL=2), block here printing task-list every Ns
#
# Exit codes: 0 success (coordinator running in background, or dry-run).

set -euo pipefail

REQUEST="${1:-}"
WORKTREE="${2:-}"
MAX_CONCURRENT="${3:-3}"

ORCA="${ORCA:-orca}"
DECOMPOSE_CMD_DEFAULT='claude --print'
CLI="${ORCA}"

err() { printf '✖ %s\n' "$*" >&2; }
log() { printf '• %s\n' "$*" >&2; }

if [[ -z "$REQUEST" ]]; then
  err "usage: $0 \"<request>\" <worktree-selector> [n_concurrent]"
  exit 1
fi
if [[ -z "$WORKTREE" ]]; then
  err "a --worktree selector is required (without it the drift guard is inert; see coordinator §7.4)"
  exit 1
fi

DECOMPOSE_CMD="${DECOMPOSE_CMD:-$DECOMPOSE_CMD_DEFAULT}"

log "Decomposing request with: ${DECOMPOSE_CMD}"
PLAN_JSON="$(eval "$DECOMPOSE_CMD" "\"$REQUEST

Output ONLY a JSON array (no prose, no code fences). Each element:
  {\"spec\":\"<implementation instructions the worker will execute>\",
   \"task_title\":\"<short slug>\",
   \"deps\":[\"#1\"]}
'deps' uses 1-indexed '#n' references to EARLIER entries. Order the array
topologically — entries with no deps come first — so each '#n' reference
resolves to an already-created task. Keep it to 2-6 tasks for a first run.\""
)"

# Relax: accept a fenced ```json … ``` block from chatty models.
PLAN_JSON="$(printf '%s' "$PLAN_JSON" | sed -n '/^[[:space:]]*```json/,/```/p; /^[[:space:]]*\[/,/\]/p' \
            | sed -e '1{/^```/d;}' -e '${/```/d;}' || printf '%s' "$PLAN_JSON")"

if ! printf '%s' "$PLAN_JSON" | jq -e 'type=="array"' >/dev/null 2>&1; then
  err "decomposition did not return a JSON array; raw output:"
  printf '%s\n' "$PLAN_JSON" >&2
  exit 1
fi

COUNT=$(printf '%s' "$PLAN_JSON" | jq 'length')
log "Plan has ${COUNT} task(s):"
printf '%s\n' "$PLAN_JSON" \
  | jq -r '.|to_entries[]|"\(.key+1). \(.value.task_title) (deps: \(.value.deps|if .==[] then \"-\" else .|join(\",\") end))"' >&2

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log "DRY_RUN=1 — not creating tasks or starting coordinator."
  exit 0
fi

# ── Create tasks in array order. We trust the LLM emitted a topological
# array (deps reference only earlier entries). If a "#n" points forward we
# refuse — task-update cannot add deps later, so half-built is unrecoverable.
declare -a IDS
for i in $(seq 0 $((COUNT-1))); do
  TITLE="$(printf '%s' "$PLAN_JSON" | jq -r  ".[$i].task_title")"
  SPEC="$(printf '%s'   "$PLAN_JSON" | jq -r  ".[$i].spec")"
  DEPS_RAW="$(printf '%s' "$PLAN_JSON" | jq -r ".[$i].deps[]?")"

  DEPS_JSON="[]"
  for ref in $DEPS_RAW; do
    IDX="$(( ${ref#\#} - 1 ))"
    if (( IDX < 0 || IDX >= i )); then
      err "task #${i} deps reference '${ref}' is out-of-order or forward — refusing " \
         "(topological creation is required; task-update cannot add deps)."
      exit 1
    fi
    REAL="${IDS[$IDX]}"
    DEPS_JSON="$(printf '%s' "$DEPS_JSON" | jq --arg id "$REAL" '.+[$id]')"
  done

  OUT="$("${CLI}" orchestration task-create --spec "${SPEC}" \
        --task-title "${TITLE}" --display-name "${TITLE}" --deps "${DEPS_JSON}" --json)"
  ID="$(printf '%s' "$OUT" | jq -r '.task.id')"
  IDS[$i]="$ID"
  log "  created [${ID}] ${TITLE}  deps=$(printf '%s' "$DEPS_JSON" | jq -c .)"
done

# ── Start the coordinator. run is fire-and-forget: the loop lives in the
# runtime, results persisted to the orchestration DB. We return immediately.
log "Starting coordinator  --worktree '${WORKTREE}' --max-concurrent ${MAX_CONCURRENT}"
RUN="$("${CLI}" orchestration run \
        --spec "${REQUEST}" --from coordinator \
        --max-concurrent "${MAX_CONCURRENT}" --poll-interval-ms 2000 \
        --worktree "${WORKTREE}" --json)"

RUN_ID="$(printf '%s' "$RUN" | jq -r '.runId')"
log "Coordinator run started: ${RUN_ID}"
log ""
log "Watch:    ${CLI} orchestration task-list --json"
log "Dispatch: ${CLI} orchestration task-list --status dispatched --json"
log "Stop:     ${CLI} orchestration run-stop"
log "Worker wrappers — when the coordinator spawns a 'Worker:' terminal, launch"
log "            it via dispatch-worker.sh (see that script's header)."
printf '%s\n' "$RUN"

# ── Optional poll loop so the script blocks and shows progress.
if [[ -n "${POLL:-}" ]]; then
  log "POLL=${POLL} — printing task-list every ${POLL}s until coordinator exits."
  while true; do
    "${CLI}" orchestration task-list --json \
      | jq -r '.tasks|group_by(.status)|map({(.[0].status): map(.display_name)})|.[]' >&2 \
      || true
    if ! "${CLI}" orchestration task-list --json \
         | jq -e '.tasks|all(.status=="completed" or .status=="failed")' >/dev/null 2>&1; then
      sleep "${POLL}"
    else
      log "All tasks reached a terminal state."
      break
    fi
  done
fi
