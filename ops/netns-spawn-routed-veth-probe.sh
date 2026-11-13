#!/usr/bin/env sh
# spawnOwned ROUTED proxy env + veth CONNECT stack probe (ruling **319**).
# Advisory only — does NOT plumb veth inside hz-sandbox-exec or claim enforced.
#
# Requires: HZ_EGRESS_NETNS_PROXY_ROUTED=1, HZ_EGRESS_NETNS_BRIDGE_HOST, parent
# HZ_EGRESS_PROXY (loopback port echoed to bridge URL for spawn wiring honesty).
# Runs netns-veth-connect-probe.sh when PROXY_PORT + CONNECT_AUTHORITY set.
#
# Usage:
#   HZ_EGRESS_PROXY=http://127.0.0.1:4317 \
#   HZ_EGRESS_NETNS_PROXY_ROUTED=1 \
#   HZ_EGRESS_NETNS_BRIDGE_HOST=10.199.0.1 \
#   PROXY_PORT=4317 CONNECT_AUTHORITY=host:port \
#   ./ops/netns-spawn-routed-veth-probe.sh
# Exit: 0 wiring + veth probes pass; 2 CAP/ip missing; 3 probe failed; 4 usage.

set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
VETH_PROBE="${ROOT}/ops/netns-veth-connect-probe.sh"

BRIDGE_HOST="${HZ_EGRESS_NETNS_BRIDGE_HOST:-10.199.0.1}"
ROUTED="${HZ_EGRESS_NETNS_PROXY_ROUTED:-}"

if [ -z "$ROUTED" ] || [ "$ROUTED" = "0" ] || [ "$ROUTED" = "false" ]; then
  echo "HZ_EGRESS_NETNS_PROXY_ROUTED unset — spawn ROUTED stack not configured" >&2
  exit 4
fi

PARENT_PROXY="${HZ_EGRESS_PROXY:-}"
if [ -z "$PARENT_PROXY" ]; then
  echo "HZ_EGRESS_PROXY unset — cannot derive spawn child bridge proxy URL" >&2
  exit 4
fi

# Derive child-facing proxy URL (mirror deriveNetnsBridgeProxyUrl).
case "$PARENT_PROXY" in
  http://127.0.0.1:*|http://localhost:*)
    PORT="${PARENT_PROXY##*:}"
    CHILD_PROXY="http://${BRIDGE_HOST}:${PORT}"
    echo "spawn ROUTED child proxy (advisory): ${CHILD_PROXY}"
    ;;
  *)
    CHILD_PROXY="$PARENT_PROXY"
    echo "spawn child proxy (non-loopback parent): ${CHILD_PROXY}"
    ;;
esac

if [ -z "${PROXY_PORT:-}" ] || [ -z "${CONNECT_AUTHORITY:-}" ]; then
  echo "usage: PROXY_PORT=<port on bridge> CONNECT_AUTHORITY=host:port $0" >&2
  echo "  (+ HZ_EGRESS_NETNS_PROXY_ROUTED=1 HZ_EGRESS_NETNS_BRIDGE_HOST HZ_EGRESS_PROXY)" >&2
  exit 4
fi

export VETH_BRIDGE_HOST="$BRIDGE_HOST"
exec "$VETH_PROBE"
