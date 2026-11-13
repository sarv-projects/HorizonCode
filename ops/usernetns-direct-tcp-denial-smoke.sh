#!/usr/bin/env bash
# Advisory Linux capability probe, not product netns/proxy enforcement.
# Exit 0 = this *disposable* user+network namespace refused a real TCP connect.
# Exit 77 = this host cannot establish the required namespace; NOT a PASS.
# Exit 1 = missing denial, unexpected failure or evidence not trustworthy.
set -euo pipefail

if ! command -v unshare >/dev/null || ! command -v python3 >/dev/null; then
  echo 'UNSUPPORTED: unshare or python3 missing; no network enforcement claim' >&2
  exit 77
fi
if ! unshare --user --map-root-user --net true >/dev/null 2>&1; then
  echo 'UNSUPPORTED: user+net namespace unavailable on this host; no denial proof' >&2
  exit 77
fi

unshare --user --map-root-user --net python3 - <<'PY'
import errno
import socket
from pathlib import Path

# No inherited default route should exist in a newly isolated namespace.
# This proves ONLY this isolated child namespace, not the HorizonCode runtime.
routes = Path('/proc/net/route').read_text().splitlines()[1:]
if any(len(parts := row.split()) >= 2 and parts[1] == '00000000' for row in routes):
    raise SystemExit('FAIL: isolated namespace has a default IPv4 route')

target = ('1.1.1.1', 443)
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(2)
    try:
        sock.connect(target)
    except OSError as exc:
        if exc.errno in {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ENETDOWN, errno.EPERM, errno.EACCES}:
            print(f'PASS: isolated namespace direct TCP {target[0]}:{target[1]} refused with errno {exc.errno}')
        else:
            raise SystemExit(f'FAIL: unexpected direct TCP error {exc}; not a proved route denial')
    else:
        raise SystemExit('FAIL: isolated namespace unexpectedly reached external TCP destination')
print('SCOPE: disposable user+net namespace only; NOT HorizonCode product shell-net enforcement')
PY
