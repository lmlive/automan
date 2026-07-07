#!/usr/bin/env bash
# finalize-verify.sh — post-orchestration end-of-run report + worktree sanity check.
#
# Why: decompose-and-run.sh returns immediately (run is fire-and-forget; the
# loop lives in the runtime). After the workers converge you want a single
# command that answers "did it actually work?" — final run state, per-task
# outcomes, decision-gate resolutions, and a git diff stat of the worktree so
# the human can see what changed without opening the app.
#
# This is READ-ONLY. It does not call any status-mutating verb. If you want to
# stop a stuck run, run `orca orchestration run-stop` separately.
#
# Usage:
#   ./finalize-verify.sh <worktree-path> [run-id]
#       <worktree-path>  the worktree the coordinator was launched with (--worktree)
#       [run-id]         optional; if omitted, infers the coordinator's --from
#                        handle default ('coordinator') and reports the latest run
#                        plus all tasks regardless of run.
# Env:
#   ORCA   orca/orca-dev binary (default: from PATH)

set -euo pipefail
ORCA="${ORCA:-orca}"
WORKTREE="${1:-}"

err() { printf '✖ %s\n' "$*" >&2; }
say() { printf '%s\n' "$*"; }

if [[ -z "$WORKTREE" ]]; then
  err "usage: $0 <worktree-path> [run-id]"
  exit 1
fi
if [[ ! -d "$WORKTREE/.git" && ! -f "$WORKTREE/.git" ]]; then
  err "'${WORKTREE}' does not look like a git worktree (no .git)"
  exit 1
fi

RUN_ID="${2:-}"

say "════════ orca orchestration — finalize verify ════════"
say "worktree : ${WORKTREE}"
[[ -n "$RUN_ID" ]] && say "run-id   : ${RUN_ID}"

# ── Per-task outcomes. ─────────────────────────────────────────────────────
TASKS="$("${ORCA}" orchestration task-list --json 2>/dev/null || echo '{"tasks":[]}')"
TOTAL="$(printf '%s' "$TASKS" | jq -r '.tasks|length')"
DONE="$(printf  '%s' "$TASKS" | jq -r '[.tasks[]|select(.status=="completed")]|length')"
FAIL="$(printf  '%s' "$TASKS" | jq -r '[.tasks[]|select(.status=="failed")]|length')"
PEND="$(printf  '%s' "$TASKS" | jq -r '[.tasks[]|select(.status=="pending" or .status=="ready" or .status=="dispatched" or .status=="blocked")]|length')"

say "tasks    : ${TOTAL} (completed=${DONE}  failed=${FAIL}  in-flight/blocked=${PEND})"
printf '%s' "$TASKS" | jq -r '.tasks|sort_by(.id)|.[]|"  [\(.status)] \(.id)  \(.display_name // .task_title // .spec[0:50])"' \
  | sed 's/\[/   [/'

# ── Per-task worker_done summaries + report paths. ──────────────────────────
# Inbox for the coordinator handle holds the worker_done messages; their bodies
# are the 3-sentence summaries the workers sent, and --payload may carry
# reportPath. Quiet nulls.
INBOX="$("${ORCA}" orchestration inbox --terminal coordinator --limit 200 --json 2>/dev/null || echo '{"messages":[]}')"
say ""
say "── worker reports (worker_done) ──"
printf '%s' "$INBOX" \
  | jq -r '.messages|map(select(.type=="worker_done"))|sort_by(.created_at)|.[]|"  \(.subject)\n     body: \(.body // "-")\n     payload: \(.payload // "-")"' 2>/dev/null \
  | head -60 || say "  (none)"

# ── Decision gates ──────────────────────────────────────────────────────────
say ""
say "── decision gates ──"
"${ORCA}" orchestration gate-list --json 2>/dev/null \
  | jq -r '.gates|if length==0 then "  (none)" else sort_by(.created_at)|.[]"  [\(.status)] \(.id)  Q: \(.question)  -> \(.resolution // "<pending>")" end' \
  || say "  (gate-list unavailable)"

# ── Convergence verdict ─────────────────────────────────────────────────────
say ""
if [[ "$PEND" == "0" ]]; then
  if [[ "$FAIL" == "0" ]]; then
    say "VERDICT  : ✅ all tasks completed"
  else
    say "VERDICT  : ⚠ run reached a terminal state but ${FAIL} task(s) failed"
  fi
else
  say "VERDICT  : ⏳ ${PEND} task(s) still not terminal — wait or run-stop"
fi

# ── git diff stat of the worktree (what actually changed on disk). ──────────
say ""
say "── git diff --stat (${WORKTREE}) ──"
if ( cd "$WORKTREE" && git rev-parse --is-inside-work-tree >/dev/null 2>&1 ); then
  ( cd "$WORKTREE" && git --no-pager diff --stat HEAD 2>/dev/null ) \
    | sed 's/^/  /' \
    || say "  (git diff unavailable)"
else
  say "  (not a git worktree — skipped)"
fi
say "══════════════════════════════════════════════════════"
