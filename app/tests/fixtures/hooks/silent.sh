#!/usr/bin/env bash
# hook fixture: reads its input and exits 0 with NO stdout — missing output,
# which the protocol treats as a failure (one output line is required).
IFS= read -r _input || true
exit 0
