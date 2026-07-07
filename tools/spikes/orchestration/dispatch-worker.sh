#!/usr/bin/env bash
# dispatch-worker.sh — launch a real headless agent as a dispatched Orca worker,
# and report back through the coordinator's CLI exactly as the dispatch
# preamble demands.
#
# Why: when the coordinator dispatches a task it does `createTerminal` (a plain
# terminal) and `sendTerminal({ text: preamble+TASK, enter:true })`. The preamble
# *teaches* the worker the orca CLI templates but does NOT start any agent —
# that boundary is left to you. This script bridges it: parse the preamble so we
# know task-id / dispatch-id / coordinator-handle / cli variant, frame a prompt
# that tells the agent to honor the preamble's rules (heartbeat cadence, thank,
# worker_done exactly once, ask/escalate instead of AskUserQuestion), then run.
#
# Two modes:
#   A) Piped preamble  — coordinator output piped in, e.g.
#        dispatch-worker.sh < preamble.txt
#   B) Resolved from RPC — `dispatch-worker.sh --task <id>`
#      Uses `orchestration dispatch-show --preamble` (READ-ONLY; reuses the
#      existing dispatch_context.id when one exists, else falls back to a
#      placeholder) so you can stand up or replay a worker outside the Orca
#      terminal UI. We deliberately do NOT use `dispatch --inject --dry-run`
#      here: dry-run always ignores --to and emits dispatchId='ctx_dryrun'
#      with dispatch=null, so heartbeats could not be attributed to the real
#      dispatch context. dispatch-show reuses ctx.id and mutates nothing.
#
# Env:
#   ORCA              orca/orca-dev binary          (default: from PATH)
#   AGENT             command to run the agent; argv gets the system prompt;
#                     the agent runs in CWD (= the worktree). default:
#                       'claude'
#                     Do NOT default to --dangerously-skip-permissions; that
#                     flag bypasses per-action approval, which is Orca's
#                     safety contract. Set it yourself only if you accept the
#                     risk of an autonomous loop touching your worktree.
#   HEARTBEAT_SECONDS override the 5-min preamble cadence locally (the on-wire
#                     heartbeat the agent SENDS still follows the preamble text;
#                     this is only for a guard ping while the wrapper waits).
#   COORDINATOR       overrides coordinator handle parsed from preamble.
#
# The agent is told to do the work and, on completion, emit the worker_done
# line itself — consistent with the preamble behaviour rules. We also let the
# agent run `ask`/`check` itself; we do not intercept those.
#
# Exit codes: 0 if the agent reported worker_done (we let it run to completion
# of its own process); 2 if we could not parse the preamble; 1 other.

set -euo pipefail

ORCA="${ORCA:-orca}"
AGENT="${AGENT:-claude}"
CLI_OUT=""

err()  { printf '✖ %s\n' "$*" >&2; }
log()  { printf '• %s\n' "$*" >&2; }

# ── Mode B: resolve preamble via dispatch-show (read-only). ────────────────
# dispatch-show --preamble retises the existing dispatch_context.id if the
# task was already dispatched, so heartbeats attribute to the real context;
# if the task hasn't been dispatched yet (e.g. you're pre-staging a worker
# that the coordinator will dispatch to), it returns ctx_preview — in that
# case we fall back to the preamble-parsed dispatch-id line and warn.
PREAMBLE=""
if [[ "$#" -ge 2 && "${1:-}" == "--task" ]]; then
  TASK_ID="${2}"
  SHOW="$("${ORCA}" orchestration dispatch-show --task "${TASK_ID}" --preamble --json)"
  PREAMBLE="$(printf '%s' "$SHOW" | jq -r '.preamble')"
  # Prefer the real ctx.id when the coordinator has already dispatched.
  if [[ "$(printf '%s' "$SHOW" | jq -r '.dispatch.id // empty')" != "" ]]; then
    DISPATCH_ID="$(printf '%s' "$SHOW" | jq -r '.dispatch.id')"
  else
    DISPATCH_ID="(no-dispatch-yet: failure is still a worker_done)"
  fi
fi

# ── Mode A: read piped preamble from stdin (or first CLI arg). ──────────────
if [[ -z "$PREAMBLE" ]]; then
  if [[ ! -t 0 ]]; then
    PREAMBLE="$(cat)"
  elif [[ -n "${1:-}" && -f "${1:-}" ]]; then
    PREAMBLE="$(cat "$1")"
  fi
fi

if [[ -z "$PREAMBLE" ]]; then
  err "no preamble supplied. Pipe it in, pass a file, or use:"
  err "    dispatch-worker.sh --task <id> --dispatch <id>"
  exit 2
fi

# ── Parse the four facts we need out of the preamble header. ────────────────
COORDINATOR="${COORDINATOR:-$(printf '%s' "$PREAMBLE" \
              | sed -n "s/.*coordinator's terminal handle is:[[:space:]]*\([^[:space:]]*\).*/\1/p" | head -1)}"
TASK_ID="${TASK_ID:-$(printf '%s' "$PREAMBLE" \
            | sed -n "s/.*Your task ID is:[[:space:]]*\([^[:space:]]*\).*/\1/p" | head -1)}"
DISPATCH_ID="${DISPATCH_ID:-$(printf '%s' "$PREAMBLE" \
              | sed -n "s/.*--dispatch-id[[:space:]]*\([A-Za-z0-9_-]*\).*/\1/p" | head -1)}"
CLI_OUT="$(printf '%s' "$PREAMBLE" \
            | sed -n "s|^[[:space:]]*\([a-zA-Z-]*\) orchestration send --to.*|\1|p" | head -1)"
CLI="${CLI_OUT:-orca}"
DISPATCH_ID="${DISPATCH_ID:-<unknown-dispatch>}"

if [[ -z "${COORDINATOR}" || -z "${TASK_ID}" ]]; then
  err "could not parse coordinator handle or task id from preamble"
  exit 2
fi
log "parsed preamble → coordinator=${COORDINATOR} task=${TASK_ID} dispatch=${DISPATCH_ID} cli=${CLI}"

# ── Build the system prompt that tells the agent to OBEY the preamble. ──────
# The preamble is the source of truth; we restate only the invariants that LLMs
# reliably get wrong without a nudge: worker_done once, never AskUserQuestion,
# heartbeat cadence, both ids in payload (a straggler from a failed retry must
# not complete the current dispatch).
SYSTEM_PROMPT="$(cat <<EOF
You are a dispatched Orca worker. The dispatch preamble below defines the only
allowed communication channel to your coordinator. Follow it EXACTLY.

INVARIANTS (do not violate):
 1. Do the task described under \`=== TASK ===\`. Work in the current directory,
    which is your isolated git worktree.
 2. While actively working, every ${HEARTBEAT_SECONDS:-300}s send one heartbeat
    so the coordinator can tell "still working" from "hung":
      ${CLI} orchestration send --to ${COORDINATOR} --type heartbeat \
        --subject alive --task-id ${TASK_ID} --dispatch-id ${DISPATCH_ID} \
        --phase "<investigating|implementing|reviewing|waiting>"
    Skip a heartbeat ONLY while inside the \`check --wait\` and \`ask\` verbs —
    those calls are themselves liveness signals.
 3. NEVER use AskUserQuestion. For any interactive question,
      ${CLI} orchestration ask --to ${COORDINATOR} --question "<...>" \\
        --options "<optional,comma,separated>" --timeout-ms 600000
    or send an \`escalation\` message. AskUserQuestion opens a TUI prompt the
    coordinator cannot see — your session hangs forever.
 4. When done (success OR failure), send worker_done EXACTLY ONCE, with BOTH
    --task-id ${TASK_ID} AND --dispatch-id ${DISPATCH_ID} (a late completion
    from a failed retry must not complete the current dispatch):
      ${CLI} orchestration send --to ${COORDINATOR} --type worker_done \\
        --subject "<short status>" \\
        --body "<3-sentence summary: what you did, what you found, what's left>" \\
        --task-id ${TASK_ID} --dispatch-id ${DISPATCH_ID} \\
        --files-modified "path/a,path/b" \\
        --report-path "<optional path to full artifact>"
    Failure is ALSO a worker_done with subject "Failed: <reason>" — never exit
    silently.
 5. After worker_done, keep the shell alive ~10 min; poll
      ${CLI} orchestration check
    every 2 min. If the coordinator re-dispatches you (fresh preamble + TASK),
    reset and start the new task.

=== DISPATCH PREAMBLE ===
${PREAMBLE}
EOF
)"

# ── Run the agent in the current (worktree) directory. ──────────────────────
# We do NOT auto-kill it on heartbeat — the agent itself owns worker_done; our
# job is launch + (optionally) a guard ping that proves the wrapper is alive.
log "launching agent: ${AGENT}"
exec ${AGENT} "${SYSTEM_PROMPT}"
