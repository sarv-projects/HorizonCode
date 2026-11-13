#!/usr/bin/env bash
# Advisory probe: hz-sandbox-exec in-wrapper veth netns join (ruling **324**).
# Parent must create the netns + veth; wrapper only setns-joins when env is set.
# Never claim shell-net enforced.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SBX_BIN="${HZ_SANDBOX_EXEC_BIN:-$ROOT/kernel/target/debug/hz-sandbox-exec}"
NS="${HZ_SANDBOX_VETH_NETNS:-hz-exec-veth-join-probe}"

if [[ ! -x "$SBX_BIN" ]]; then
  echo "hz-sandbox-exec missing at $SBX_BIN — build kernel/ first" >&2
  exit 2
fi

ip netns del "$NS" 2>/dev/null || true
if ! ip netns add "$NS"; then
  echo "CAP_NET_ADMIN required for parent netns — join path unproven" >&2
  exit 0
fi

trap 'ip netns del "'"$NS"'" 2>/dev/null || true' EXIT

if ! env \
  HZ_SANDBOX_CHILD_NET=off HZ_SANDBOX_VETH_JOIN=1 HZ_SANDBOX_VETH_NETNS="$NS" \
  "$SBX_BIN" -- python3 -c 'import os; print(open("/proc/self/ns/net").readlink())' 2>/tmp/hz-veth-join-probe.err; then
  echo "veth join pre_exec failed (expected on some hosts):" >&2
  cat /tmp/hz-veth-join-probe.err >&2 || true
  exit 0
fi

echo "hz-sandbox-exec joined prepared netns $NS — in-wrapper veth create still open; never enforced"
