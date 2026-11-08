#!/usr/bin/env bash
# hook fixture: TWO JSON lines on stdout — extra output, which is as much a
# protocol failure as garbage (exactly one line is the contract).
IFS= read -r _input || true
printf '%s\n' '{"decision":"allow"}'
printf '%s\n' '{"decision":"allow"}'
