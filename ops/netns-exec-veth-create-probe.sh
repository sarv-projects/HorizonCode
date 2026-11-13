#!/usr/bin/env bash
# Advisory probe: hz-sandbox-exec in-wrapper veth create (ruling **329**).
# Opt-in HZ_SANDBOX_VETH_CREATE=1 after user+net unshare; never claim shell-net enforced.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SBX_BIN="${HZ_SANDBOX_EXEC_BIN:-$ROOT/kernel/target/debug/hz-sandbox-exec}"
HOST="${HZ_SANDBOX_VETH_HOST:-hz-exec-veth-create-h}"
PEER="${HZ_SANDBOX_VETH_PEER:-hz-exec-veth-create-p}"
PEER_ADDR="${HZ_SANDBOX_VETH_PEER_ADDR:-}"
HOST_ADDR="${HZ_SANDBOX_VETH_HOST_ADDR:-}"
DEFAULT_ROUTE="${HZ_SANDBOX_VETH_DEFAULT_ROUTE:-}"

if [[ ! -x "$SBX_BIN" ]]; then
  echo "hz-sandbox-exec missing at $SBX_BIN — build kernel/ first" >&2
  exit 2
fi

ip link del "$HOST" 2>/dev/null || true
ip link del "$PEER" 2>/dev/null || true
trap 'ip link del "'"$HOST"'" 2>/dev/null || true; ip link del "'"$PEER"'" 2>/dev/null || true' EXIT

PLUMB_ENV=()
[[ -n "$PEER_ADDR" ]] && PLUMB_ENV+=(HZ_SANDBOX_VETH_PEER_ADDR="$PEER_ADDR")
[[ -n "$HOST_ADDR" ]] && PLUMB_ENV+=(HZ_SANDBOX_VETH_HOST_ADDR="$HOST_ADDR")
[[ -n "$DEFAULT_ROUTE" ]] && PLUMB_ENV+=(HZ_SANDBOX_VETH_DEFAULT_ROUTE="$DEFAULT_ROUTE")

if ! env \
  HZ_SANDBOX_CHILD_NET=off \
  HZ_SANDBOX_VETH_CREATE=1 \
  HZ_SANDBOX_VETH_HOST="$HOST" \
  HZ_SANDBOX_VETH_PEER="$PEER" \
  "${PLUMB_ENV[@]}" \
  "$SBX_BIN" -- python3 -c "import subprocess; subprocess.check_call(['ip','link','show', '$HOST'])" 2>/tmp/hz-veth-create-probe.err; then
  echo "in-wrapper veth create failed (expected on some hosts without userns CAP_NET_ADMIN):" >&2
  cat /tmp/hz-veth-create-probe.err >&2 || true
  exit 0
fi

if ip link show "$PEER" &>/dev/null; then
  echo "peer $PEER present in parent netns — in-wrapper create slice ok; ADDR/route plumb (**331**) advisory only; CONNECT product path still open; never enforced"
else
  echo "host $HOST in child only — peer move may be host-specific; never enforced"
fi
