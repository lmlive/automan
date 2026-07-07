#!/usr/bin/env bash
# fake-decompose.sh — deterministic stand-in DECOMPOSE_CMD for decompose-and-run.sh.
#
# It ignores the request argv and emits a fixed 3-task topologically-ordered DAG
# as JSON: t1 (no deps), t2 (deps t1), t3 (deps t1,t2). This is what
# decompose-and-run.sh parses and feeds to `task-create`, so any real LLM
# returning the same shape would drop in identically.
#
# Usage:
#   DECOMPOSE_CMD="$HERE/fake-decompose.sh" ./decompose-and-run.sh "..." <worktree> 3
set -euo pipefail
cat <<'JSON'
[
  {"spec":"Write a function login(user,pass)->Token in src/auth.ts.","task_title":"login-api","deps":[]},
  {"spec":"Add a src/ui/LoginPage.tsx that calls login(); show honeypot errors.","task_title":"login-ui","deps":["#1"]},
  {"spec":"Playwright test: fill form, submit, assert redirect; assert failure shows error.","task_title":"login-e2e","deps":["#1","#2"]}
]
JSON
