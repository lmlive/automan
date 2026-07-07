#!/usr/bin/env bash
# fake-agent.sh — a deterministic stand-in for `claude` used to smoke-test the
# orchestration wrappers WITHOUT any LLM.
#
# It receives the system prompt on argv (just like dispatch-worker.sh hands it
# to a real agent), does some pretend work (writes one file), parses the four
# facts it needs OUT of the prompt text (coordinator / task-id / dispatch-id /
# cli binary), and emits a `worker_done` exactly the way the preamble prescribes.
#
# Why: lets you exercise the full path
#   decompose-and-run.sh → dispatch-workers.sh → (fake agent) → finalize-verify.sh
# with no API key, no model, deterministic output, in seconds. Swap it out for
# `claude`/`codex`/`gemini` by setting AGENT= when you want real agentic work.

set -euo pipefail
PROMPT="${1:-}"

# Pull the four facts out of the prompt. dispatch-worker.sh builds it, so the
# exact phrases ("coordinator's terminal handle is:", "Your task ID is:",
# "--dispatch-id", leading "orca"/"orca-dev" before "orchestration send") are
# guaranteed to be present.
COORDINATOR="$(printf '%s' "$PROMPT" \
  | sed -n "s/.*coordinator's terminal handle is:[[:space:]]*\([^[:space:]]*\).*/\1/p" | head -1)"
TASK_ID="$(printf '%s' "$PROMPT" \
  | sed -n "s/.*Your task ID is:[[:space:]]*\([^[:space:]]*\).*/\1/p" | head -1)"
DISPATCH_ID="$(printf '%s' "$PROMPT" \
  | sed -n "s/.*--dispatch-id[[:space:]]*\([A-Za-z0-9_-]*\).*/\1/p" | head -1)"
CLI="$(printf '%s' "$PROMPT" \
  | sed -n "s|^[[:space:]]*\([a-zA-Z-]*\) orchestration send --to.*|\1|p" | head -1)"
CLI="${CLI:-orca}"

if [[ -z "$COORDINATOR" || -z "$TASK_ID" || -z "$DISPATCH_ID" ]]; then
  echo "fake-agent: could not parse coordinator/task-id/dispatch-id from prompt" >&2
  exit 2
fi

echo "fake-agent: work on task ${TASK_ID} (dispatch ${DISPATCH_ID}) for ${COORDINATOR}"

# Pretend to do work — write one file into the worktree CWD so finalize-verify's
# `git diff --stat` shows something non-empty.
mkdir -p .orca-demo
cat > ".orca-demo/${TASK_ID}.txt" <<EOF
fake-agent delivered for ${TASK_ID}
dispatch: ${DISPATCH_ID}
coordinator: ${COORDINATOR}
EOF

# Report exactly as the preamble prescribes: one --type worker_done, both ids,
# non-empty 3-sentence body, files-modified, and a reportPath payload.
"$CLI" orchestration send \
  --to "$COORDINATOR" --type worker_done \
  --subject "done" \
  --body "Implemented the fake change. Wrote .orca-demo/${TASK_ID}.txt with the dispatch metadata. No remaining work." \
  --task-id "$TASK_ID" --dispatch-id "$DISPATCH_ID" \
  --files-modified ".orca-demo/${TASK_ID}.txt" \
  --report-path ".orca-demo/${TASK_ID}.txt" \
  --json >/dev/null

echo "fake-agent: reported worker_done for ${TASK_ID}"
# Preamble says keep the shell alive ~10 min for follow-ups; for a smoke test we
# just exit — nothing will re-dispatch a deterministic fake.
