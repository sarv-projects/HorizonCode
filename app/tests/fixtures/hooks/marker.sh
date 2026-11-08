#!/usr/bin/env bash
# hook fixture: reads its input, appends its label ($2) to the log named by $1
# (relative to the hook's cwd = the workspace), then allows. The log is how the
# tests prove execution order and that a short-circuited hook never ran.
IFS= read -r _input || true
printf '%s\n' "$2" >> "$1"
printf '%s\n' '{"decision":"allow"}'
