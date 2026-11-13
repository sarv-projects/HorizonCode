#!/usr/bin/env bash
# spawnOwned-wrapped CONNECT via in-wrapper CREATE+ADDR+default-route (ruling **332**).
# Advisory only — no parent veth plumb; never claim shell-net enforced.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SBX_BIN="${HZ_SANDBOX_EXEC_BIN:-$ROOT/kernel/target/debug/hz-sandbox-exec}"
BRIDGE_HOST="${HZ_EGRESS_NETNS_BRIDGE_HOST:-10.199.0.1}"
ROUTED="${HZ_EGRESS_NETNS_PROXY_ROUTED:-}"
PROXY_PORT="${PROXY_PORT:-}"
CONNECT_AUTHORITY="${CONNECT_AUTHORITY:-}"

if [[ -z "$ROUTED" || "$ROUTED" == "0" || "$ROUTED" == "false" ]]; then
  echo "HZ_EGRESS_NETNS_PROXY_ROUTED required for wrapped exec-create CONNECT probe" >&2
  exit 4
fi
if [[ -z "$PROXY_PORT" || -z "$CONNECT_AUTHORITY" ]]; then
  echo "usage: PROXY_PORT=<bridge port> CONNECT_AUTHORITY=host:port $0" >&2
  exit 4
fi
if [[ ! -x "$SBX_BIN" ]]; then
  echo "hz-sandbox-exec missing at $SBX_BIN" >&2
  exit 2
fi

HOST="${HZ_SANDBOX_VETH_HOST:-hz-wrap-exec332-probe-h}"
PEER="${HZ_SANDBOX_VETH_PEER:-hz-wrap-exec332-probe-p}"
PEER_ADDR="${HZ_SANDBOX_VETH_PEER_ADDR:-${BRIDGE_HOST}/30}"
HOST_ADDR="${HZ_SANDBOX_VETH_HOST_ADDR:-10.199.0.2/30}"

ip link del "$HOST" 2>/dev/null || true
ip link del "$PEER" 2>/dev/null || true
trap 'ip link del "'"$HOST"'" 2>/dev/null || true; ip link del "'"$PEER"'" 2>/dev/null || true' EXIT

if ! command -v nsenter >/dev/null 2>&1; then
  echo "nsenter missing — ADDR plumb may fail; never enforced" >&2
  exit 0
fi

CHILD_PROXY="${HZ_EGRESS_PROXY:-http://127.0.0.1:${PROXY_PORT}}"
case "$CHILD_PROXY" in
  http://127.0.0.1:*|http://localhost:*)
    CHILD_PROXY="http://${BRIDGE_HOST}:${PROXY_PORT}"
    ;;
esac

CONNECT_PY='
import socket
bridge="'"${BRIDGE_HOST}"'"
port='"${PROXY_PORT}"'
authority="'"${CONNECT_AUTHORITY}"'"
s=socket.socket(); s.settimeout(8)
s.connect((bridge, port))
req=("CONNECT "+authority+" HTTP/1.1\r\nHost: "+authority+"\r\n\r\n").encode("latin1")
s.sendall(req)
head=b""
while b"\r\n\r\n" not in head and len(head)<8192:
    chunk=s.recv(4096)
    if not chunk: break
    head+=chunk
status=head.split(b"\r\n")[0].decode("latin1","replace")
print("CONNECT_VIA_SPAWN_PROXY_OK" if " 200 " in status else "CONNECT_VIA_SPAWN_PROXY_FAIL:"+status[:120])
'

echo "wrapped exec-create CONNECT probe (advisory): bridge=${BRIDGE_HOST}"

OUT="$(
  env \
    HZ_SANDBOX_CHILD_NET=off \
    HZ_SANDBOX_VETH_CREATE=1 \
    HZ_SANDBOX_VETH_HOST="$HOST" \
    HZ_SANDBOX_VETH_PEER="$PEER" \
    HZ_SANDBOX_VETH_PEER_ADDR="$PEER_ADDR" \
    HZ_SANDBOX_VETH_HOST_ADDR="$HOST_ADDR" \
    HZ_SANDBOX_VETH_DEFAULT_ROUTE=1 \
    HTTP_PROXY="$CHILD_PROXY" HTTPS_PROXY="$CHILD_PROXY" \
    "$SBX_BIN" -- python3 -c "$CONNECT_PY" 2>&1
)" || true
echo "$OUT"
echo "$OUT" | grep -q CONNECT_VIA_SPAWN_PROXY_OK || {
  echo "in-wrapper CREATE+ADDR CONNECT failed (CAP/userns gap is honest on some hosts)" >&2
  exit 3
}

echo "wrapped exec-create CONNECT advisory probe complete (never enforced)"
