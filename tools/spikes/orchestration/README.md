# Orchestration headless wrappers (v1 "brain" layer)

Orca's orchestration coordinator (`src/main/runtime/orchestration/coordinator.ts`)
deliberately does **not** auto-decompose a request — it's a pure scheduler with
drift / heartbeat / circuit-breaker / decision-gate protections. Its comment:

> AI-driven decomposition belongs in a future phase where the coordinator
> itself is an LLM agent.

These four scripts supply the missing brain layer on top of the runtime, using
the public `orca orchestration ...` CLI surface only (no internal imports):

* `decompose-and-run.sh` — LLM decomposes a request into a topologically
  ordered task DAG, persists them via `task-create`, then starts the coordinator
  with `orchestration run`. Because `deps` must be a JSON array of *existing*
  task IDs (and `task-update` can only change status, not deps), tasks are
  created in array order and each `"#n"` reference is resolved to the real
  task id before its owner is created.
* `dispatch-worker.sh` — parses a dispatch preamble (coordinator handle,
  task-id, dispatch-id, dev-vs-prod CLI variant), wraps it in a system prompt
  that restates the invariants LLMs reliably get wrong (`worker_done` exactly
  once, never `AskUserQuestion`, heartbeat cadence, both ids in the payload so
  a straggler from a failed retry cannot complete the current dispatch), then
  launches a real headless agent (`claude` / `codex` / `gemini` / `droid`) in
  the worktree CWD.
* `dispatch-workers.sh` — boots one agent per dispatched task, **reactively**:
  it never dispatches itself (the coordinator owns that and would race you),
  it just polls `task-list --status dispatched` and, for each dispatched task
  without a live worker yet, calls `dispatch-worker.sh --task <id>`. Honours a
  worker cap, reaps finished pids, and exits when the run is terminal.
* `finalize-verify.sh` — read-only end-of-run report: per-task outcomes,
  `worker_done` summaries + report paths from the coordinator inbox, decision
  gates (with resolutions), a convergence verdict, and a `git diff --stat` of
  the worktree so the human sees what actually landed on disk.

## Why this shape

`Coordinator.dispatchTask` ends with `runtime.sendTerminal(target, { text:
preamble+TASK, enter:true })` — it opens a *plain* terminal and feeds it text.
The preamble *teaches* the worker the CLI templates but does not start an agent
process. Closing that gap is left to you; `dispatch-worker.sh` is the default
bridge.

## End-to-end

```bash
chmod +x decompose-and-run.sh dispatch-worker.sh
cd ~/projects/myrepo
git worktree add ../myrepo-auth -b feat/auth-orcha      # clean worktree

# 1) Decompose + start coordinator (coordinator runs in background runtime).
ORK=../automan/tools/spikes/orchestration
ORK/decompose-and-run.sh "重构认证子系统：拆成 login API、登录页 UI、E2E" ../myrepo-auth 3
#   → decompose with `claude --print`, create DAG, run, return runId.
#   set DRY_RUN=1 to inspect the plan first; set POLL=2 to block and tail.

# 2) Boot one worker per dispatched task — run this in a second shell while the
#    coordinator runs. It reactively launches an agent whenever the coordinator
ORK/dispatch-workers.sh --max-workers 3 --poll-seconds 2
#    spawns a "Worker:" terminal. Ctrl-C stops launching; running agents finish
#    and self-report. Exit when the run is terminal. Or, single-task manual:
ORK/dispatch-worker.sh < $ORK/preamble.txt   # A: pipe a freshly-injected preamble
ORK/dispatch-worker.sh --task t_abc123        # B: fetch preamble via dispatch-show

# 3) When the run converges, get a single end-of-run summary.
ORK/finalize-verify.sh ../myrepo-auth

```

In mode A the coordinator's injected preamble is on the terminal; pipe it in.
In mode B the wrapper calls `orchestration dispatch-show --preamble`
(read-only; reuses `dispatch_context.id` so heartbeats attribute to the real
context, or falls back to a placeholder when the task isn't dispatched yet).

The agent gets a system prompt that restates the preamble invariants and
points it at the live `$CLI orchestration send/heartbeat/ask/check` commands
the coordinator already understands, so it reports `worker_done` once and the
loop converges.

## Env knobs

| Var | Default | Effect |
|---|---|---|
| `ORCA`        | `orca`                    | which binary to call |
| `DECOMPOSE_CMD` | `claude --print` | command that reads the request on argv and prints a JSON array of tasks. Don't hardcode `--dangerously-skip-permissions` — set it yourself only if you accept an unattended loop touching your worktree. |
| `DRY_RUN`     | unset                     | decompose-and-run prints the plan, creates nothing, doesn't run |
| `POLL`        | unset                     | if set (e.g. `2`), decompose-and-run blocks printing task statuses every Ns |
| `AGENT`       | `claude` | command dispatch-worker uses to launch the worker agent. Same caveat: add `--dangerously-skip-permissions` yourself only if you accept the risk. |
| `COORDINATOR` | parsed from preamble      | override coordinator handle |
| `HEARTBEAT_SECONDS` | `300`               | local nudge only; the on-wire cadence the agent SENDS is still the preamble's 5-min |

## Caveats (intentional simplifications)

* The decompose LLM is asked to emit a topologically ordered array; the script
  refuses forward `"#n"` references because `task-update` cannot add deps later.
* Multi-line tasks with embedded JSON use task `spec` free text; the coordinator
  re-injects it verbatim into the preamble's `=== TASK ===` block, so escape
  nothing unusual.
* Drift guard fires only when `--worktree` resolves a real selector; passing a
  relative path that the runtime can't resolve will log "guard inert" and skip
  the 20-commit check. Use a worktree the runtime knows about.

These are throwaway orchestration scaffolding, not product code — adjust freely.
The eventual goal (per the coordinator comment) is to fold the brain
(decomposition + the worker-wrap prompt) into the coordinator itself, at which
point these scripts collapse into `orca orchestration run --auto-decompose`.

## Smoke test with no LLM (`demo/`)

`demo/` ships deterministic stand-ins so the full path runs in seconds with no
model, no API key:

| File | Replaces | What it does |
|---|---|---|
| `fake-decompose.sh` | `DECOMPOSE_CMD` | emits a fixed 3-task topologically-ordered DAG |
| `fake-agent.sh` | `AGENT` | reads the system prompt, writes one file, sends one `worker_done` exactly as the preamble prescribes |
| `run-demo.sh` | (you) | makes a throwaway git repo + worktree, runs all four wrappers end-to-end, then finalize-verify |

```bash
cd tools/spikes/orchestration/demo
./run-demo.sh          # needs `orca` (or set ORCA=orca-dev) with its runtime live
```

It leaves `/tmp/orca-orch-demo` behind for inspection; remove with
`rm -rf /tmp/orca-orch-demo`. When you want real agentic work, drop the demo
shims and let `decompose-and-run.sh` / `dispatch-workers.sh` use their real
`claude`/`codex`/`gemini` defaults.
