#!/bin/sh
# J-1 fake SWE-bench harness: records the exact argv it received, then exits 0.
# Used only by hermetic tests. Never contacts the network.
out=${HZ_FAKE_SUBMIT_ARGV_OUT:-/tmp/hz-fake-submit-argv.txt}
{
  for arg in "$@"; do
    printf '%s\n' "$arg"
  done
} > "$out"
printf 'fake harness saw %s arg(s)\n' "$#"
exit 0
