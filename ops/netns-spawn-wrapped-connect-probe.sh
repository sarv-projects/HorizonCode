#!/usr/bin/env sh
# spawnOwned-wrapped CONNECT via bridge proxy (ruling **321**).
# Advisory only — hermetic child_net=on path; does NOT plumb veth inside hz-sandbox-exec.
#
# Requires parent veth plumbing (see netns-veth-connect-probe.sh) + ROUTED spawn env.
# Optionally runs wrapped CONNECT helper when HZ_SANDBOX_EXEC_BIN + CONNECT_AUTHORITY set.
#
# Usage:
#   HZ_EGRESS_PROXY=http://127.0.0.1:4317 \
#   HZ_EGRESS_NETNS_PROXY_ROUTED=1 \
#   HZ_EGRESS_NETNS_BRIDGE_HOST=10.199.0.1 \
#   PROXY_PORT=4317 CONNECT_AUTHORITY=host:port \
#   HZ_SANDBOX_EXEC_BIN=/path/to/hz-sandbox-exec \
#   ./ops/netns-spawn-wrapped-connect-probe.sh
# Exit: 0 wiring + veth probes pass; 2 CAP/ip missing; 3 probe failed; 4 usage.

set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ROUTED_PROBE="${ROOT}/ops/netns-spawn-routed-veth-probe.sh"

BRIDGE_HOST="${HZ_EGRESS_NETNS_BRIDGE_HOST:-10.199.0.1}"
ROUTED="${HZ_EGRESS_NETNS_PROXY_ROUTED:-}"
SBX_BIN="${HZ_SANDBOX_EXEC_BIN:-}"

if [ -z "$ROUTED" ] || [ "$ROUTED" = "0" ] || [ "$ROUTED" = "false" ]; then
  echo "HZ_EGRESS_NETNS_PROXY_ROUTED unset — spawn wrapped CONNECT probe not configured" >&2
  exit 4
fi

if [ -z "${PROXY_PORT:-}" ] || [ -z "${CONNECT_AUTHORITY:-}" ]; then
  echo "usage: PROXY_PORT=<bridge port> CONNECT_AUTHORITY=host:port $0" >&2
  echo "  (+ HZ_EGRESS_NETNS_PROXY_ROUTED HZ_EGRESS_NETNS_BRIDGE_HOST HZ_EGRESS_PROXY)" >&2
  exit 4
fi

echo "spawn ROUTED wrapped CONNECT probe (advisory): bridge=${BRIDGE_HOST}"

"$ROUTED_PROBE" || exit 3

if [ -n "$SBX_BIN" ] && [ -x "$SBX_BIN" ]; then
  PARENT_PROXY="${HZ_EGRESS_PROXY:-}"
  case "$PARENT_PROXY" in
    http://127.0.0.1:*|http://localhost:*)
      PORT="${PARENT_PROXY##*:}"
      CHILD_PROXY="http://${BRIDGE_HOST}:${PORT}"
      ;;
    *)
      CHILD_PROXY="$PARENT_PROXY"
      ;;
  esac
  echo "hz-sandbox-exec hermetic child_net=on CONNECT probe (not production child_net=off)"
  OUT="$(
    HZ_SANDBOX_CHILD_NET=on HTTP_PROXY="$CHILD_PROXY" HTTPS_PROXY="$CHILD_PROXY" \
      "$SBX_BIN" -- python3 -c "
import socket
bridge='${BRIDGE_HOST}'
port=${PROXY_PORT}
authority='${CONNECT_AUTHORITY}'
s=socket.socket(); s.settimeout(5)
s.connect((bridge, port))
req=('CONNECT '+authority+' HTTP/1.1\\r\\nHost: '+authority+'\\r\\n\\r\\n').encode('latin1')
s.sendall(req)
head=b''
while b'\\r\\n\\r\\n' not in head and len(head)<8192:
    chunk=s.recv(4096)
    if not chunk: break
    head+=chunk
status=head.split(b'\\r\\n')[0].decode('latin1','replace')
print('CONNECT_VIA_SPAWN_PROXY_OK' if ' 200 ' in status else 'CONNECT_VIA_SPAWN_PROXY_FAIL:'+status[:120])
" 2>&1
  )" || true
  echo "$OUT"
  echo "$OUT" | grep -q CONNECT_VIA_SPAWN_PROXY_OK || {
    echo "wrapped CONNECT hermetic probe failed — in-wrapper veth still open" >&2
    exit 3
  }
fi

echo "spawn wrapped CONNECT advisory probe complete (never enforced)"
