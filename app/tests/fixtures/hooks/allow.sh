#!/usr/bin/env bash
# hook fixture: reads its one input line and allows. The minimal well-behaved
# pre/post hook: exactly one JSON line on stdout, exit 0.
IFS= read -r _input || true
printf '%s\n' '{"decision":"allow"}'
