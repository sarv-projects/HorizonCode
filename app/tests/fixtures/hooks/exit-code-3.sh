#!/usr/bin/env bash
# hook fixture: writes a VALID allow line and then exits 3. The non-zero exit
# must still fail the hook — a hook cannot outrun its own exit code.
IFS= read -r _input || true
printf '%s\n' '{"decision":"allow"}'
exit 3
