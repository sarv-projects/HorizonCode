#!/bin/sh
#
# ops/landlock-probe.sh — is Landlock usable on this host?
#
# The re-runnable half of the NF-016 Landlock spike
# (docs/audit/landlock-spike-2026-11-08.md). Landlock is the unprivileged,
# per-path Linux sandbox candidate for Code Mode / shell confinement; it needs
# a Linux kernel >= 5.13 with the landlock LSM compiled in and active. This
# probe reports what THIS host can offer and is meant to become a deployment
# gate: exit 0 means "usable here", exit 3 means "not usable here".
#
# It prints, in order:
#   kernel release          uname -r
#   kernel >= 5.13          the version verdict (major.minor only; suffixes
#                           like -gvisor / -generic / -rc1 are not digits)
#   LSM list                /sys/kernel/security/lsm when present & readable
#   landlock in LSM list    yes/no, from the list above
#   kallsyms corroboration  first `grep -i landlock /proc/kallsyms` match when
#                           /proc/kallsyms is readable; otherwise skipped
#   unshare -Ur true        attempt (unprivileged user namespace)
#   bwrap --version         attempt (bubblewrap availability)
#   verdict                 one line naming the reason when not usable
#
# Exit: 0  Landlock usable: kernel >= 5.13 AND 'landlock' in the LSM list.
#       3  Not usable; the verdict line names the first failed requirement.
#
# Read-only and offline: no network, no files created, no state changed.
# POSIX sh (dash-clean); no bashisms.
#
# Usage:  sh ops/landlock-probe.sh

set -u

printf '== landlock probe (NF-016) ==\n'

# ---------------------------------------------------------------- kernel -----

release="$(uname -r 2>/dev/null)" || release=""
if [ -z "$release" ]; then
  release="(unknown)"  # uname failed; the verdict below fails closed
fi
printf 'kernel release          : %s\n' "$release"

# Compare major.minor only. A suffix on the minor (e.g. 5.13-rc1) is trimmed
# to its leading digits; anything still unparsable cannot be usable.
kernel_ok=no
major="${release%%.*}"
rest="${release#*.}"
minor="${rest%%.*}"
case "$release" in
  *.*) : ;;
  *) major=""; minor="" ;;  # no dot: not a major.minor release string
esac
case "$major" in
  ''|*[!0-9]*) major="" ;;
esac
case "$minor" in
  *[!0-9]*) minor="${minor%%[!0-9]*}" ;;
esac
case "$minor" in
  ''|*[!0-9]*) minor="" ;;
esac
if [ -n "$major" ] && [ -n "$minor" ]; then
  if [ "$major" -gt 5 ] || { [ "$major" -eq 5 ] && [ "$minor" -ge 13 ]; }; then
    kernel_ok=yes
    kernel_note="yes ($major.$minor >= 5.13)"
  else
    kernel_note="no ($major.$minor < 5.13)"
  fi
else
  kernel_note="unknown (cannot parse '$release' as major.minor)"
fi
printf 'kernel >= 5.13          : %s\n' "$kernel_note"

# ------------------------------------------------------------------- LSM -----

lsm_file=/sys/kernel/security/lsm
lsm=""
lsm_note=""
if [ -r "$lsm_file" ]; then
  lsm="$(cat "$lsm_file" 2>/dev/null)" || lsm=""
  if [ -n "$lsm" ]; then
    lsm_note="$lsm"
  else
    lsm_note="(present but empty)"
  fi
elif [ -e "$lsm_file" ]; then
  lsm_note="(present but not readable)"
else
  lsm_note="(absent: $lsm_file)"
fi
printf 'LSM list                : %s\n' "$lsm_note"

# 'landlock' as an LSM name is unambiguous as a substring of the list.
landlock_present=no
case "$lsm" in
  *landlock*) landlock_present=yes ;;
esac
if [ "$landlock_present" = yes ]; then
  printf 'landlock in LSM list    : yes\n'
else
  printf 'landlock in LSM list    : no\n'
fi

# kallsyms is corroboration only (the LSM list decides): when it is readable
# and no landlock symbol appears, the symbols are hidden or absent too.
kallsyms_note="(skipped: /proc/kallsyms not readable)"
if [ -r /proc/kallsyms ]; then
  # The `grep -i landlock /proc/kallsyms | head -1` form; -m 1 stops at the
  # first match without a pipeline.
  first_symbol="$(grep -i -m 1 landlock /proc/kallsyms 2>/dev/null)" || first_symbol=""
  if [ -n "$first_symbol" ]; then
    kallsyms_note="found: $first_symbol"
  else
    kallsyms_note="none"
  fi
fi
printf 'kallsyms corroboration  : %s\n' "$kallsyms_note"

# ------------------------------------------------- sandbox primitives ---------

unshare_note="(skipped: unshare not found)"
if command -v unshare >/dev/null 2>&1; then
  unshare_rc=0
  unshare_msg="$(unshare -Ur true 2>&1)" || unshare_rc=$?
  if [ "$unshare_rc" -eq 0 ]; then
    unshare_note="ok (exit 0)"
  elif [ -n "$unshare_msg" ]; then
    unshare_note="failed (exit $unshare_rc: $unshare_msg)"
  else
    unshare_note="failed (exit $unshare_rc)"
  fi
fi
printf 'unshare -Ur true        : %s\n' "$unshare_note"

bwrap_rc=0
bwrap_msg="$(bwrap --version 2>&1)" || bwrap_rc=$?
case "$bwrap_rc" in
  0) bwrap_note="ok ($bwrap_msg)" ;;
  126|127) bwrap_note="not found (exit $bwrap_rc)" ;;
  *) bwrap_note="failed (exit $bwrap_rc: $bwrap_msg)" ;;
esac
printf 'bwrap --version         : %s\n' "$bwrap_note"

# ---------------------------------------------------------------- verdict -----

reason=""
if [ "$kernel_ok" != yes ]; then
  if [ -n "$major" ] && [ -n "$minor" ]; then
    reason="kernel $release is below 5.13 (Landlock requires Linux >= 5.13 with the LSM active)"
  else
    reason="kernel release '$release' cannot be parsed as major.minor (Landlock requires Linux >= 5.13 with the LSM active)"
  fi
elif [ "$landlock_present" != yes ]; then
  if [ -n "$lsm" ]; then
    reason="kernel >= 5.13, but 'landlock' is not in the LSM list ($lsm)"
  else
    reason="kernel >= 5.13, but the LSM list is unavailable ($lsm_note)"
  fi
fi

if [ -z "$reason" ]; then
  printf 'verdict                 : USABLE — kernel %s and landlock is in the LSM list (%s)\n' "$release" "$lsm"
  exit 0
fi
printf 'verdict                 : NOT USABLE — %s\n' "$reason"
exit 3
