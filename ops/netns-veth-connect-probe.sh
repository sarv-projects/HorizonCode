#!/usr/bin/env sh
# Hermetic netns veth CONNECT probe helper (ruling **315**).
# Advisory only — does NOT wire hz-sandbox-exec or claim shell-net enforced.
# Usage: PROXY_PORT=<n> CONNECT_AUTHORITY=host:port ./ops/netns-veth-connect-probe.sh
# Exit: 0 both probes pass; 2 CAP/ip missing; 3 probe failed; 4 usage.

set -eu

export VETH_BRIDGE_HOST="${VETH_BRIDGE_HOST:-10.199.0.1}"
export VETH_CHILD_ADDR="${VETH_CHILD_ADDR:-10.199.0.2}"
NS="${VETH_NS_NAME:-hz-veth-probe-ns}"
VETH_H="${VETH_HOST_NAME:-hz-veth-probe-h}"
VETH_C="${VETH_CHILD_NAME:-hz-veth-probe-c}"

if [ -z "${PROXY_PORT:-}" ] || [ -z "${CONNECT_AUTHORITY:-}" ]; then
  echo "usage: PROXY_PORT=<port> CONNECT_AUTHORITY=host:port $0" >&2
  exit 4
fi
export PROXY_PORT
export CONNECT_AUTHORITY

if ! command -v ip >/dev/null 2>&1; then
  echo "ip utility missing" >&2
  exit 2
fi

PROBE_LINK=hz-veth-cap-probe-315
if ! ip link add "$PROBE_LINK" type veth peer name "${PROBE_LINK}-b" 2>/dev/null; then
  echo "CAP_NET_ADMIN missing (cannot add veth)" >&2
  exit 2
fi
ip link del "$PROBE_LINK" 2>/dev/null || true

cleanup() {
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VETH_H" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ip netns del "$NS" 2>/dev/null || true
ip link del "$VETH_H" 2>/dev/null || true

ip netns add "$NS"
ip link add "$VETH_H" type veth peer name "$VETH_C"
ip link set "$VETH_C" netns "$NS"
ip addr add "${VETH_BRIDGE_HOST}/24" dev "$VETH_H"
ip link set "$VETH_H" up
ip netns exec "$NS" ip addr add "${VETH_CHILD_ADDR}/24" dev "$VETH_C"
ip netns exec "$NS" ip link set "$VETH_C" up
ip netns exec "$NS" ip link set lo up

OUT_DIRECT="$(ip netns exec "$NS" python3 -c 'import socket
try:
 s=socket.socket(); s.settimeout(2); s.connect(("93.184.216.34",443)); print("DIRECT_443_UNEXPECTED")
except OSError: print("DIRECT_443_BLOCKED")')"
echo "$OUT_DIRECT"
case "$OUT_DIRECT" in
  *DIRECT_443_BLOCKED*) ;;
  *) echo "direct :443 probe failed" >&2; exit 3 ;;
esac

OUT_CONNECT="$(ip netns exec "$NS" python3 -c 'import os,socket
bridge=os.environ["VETH_BRIDGE_HOST"]; port=int(os.environ["PROXY_PORT"]); authority=os.environ["CONNECT_AUTHORITY"]
s=socket.socket(); s.settimeout(5); s.connect((bridge, port))
req=("CONNECT "+authority+" HTTP/1.1\\r\\nHost: "+authority+"\\r\\n\\r\\n").encode("latin1")
s.sendall(req); head=b""
while b"\\r\\n\\r\\n" not in head and len(head)<8192:
 chunk=s.recv(4096)
 if not chunk: break
 head+=chunk
status=head.split(b"\\r\\n")[0].decode("latin1","replace")
print("CONNECT_VIA_BRIDGE_OK" if " 200 " in status else "CONNECT_VIA_BRIDGE_FAIL:"+status[:120])')"
echo "$OUT_CONNECT"
case "$OUT_CONNECT" in
  *CONNECT_VIA_BRIDGE_OK*) exit 0 ;;
  *) echo "CONNECT via bridge proxy failed" >&2; exit 3 ;;
esac
