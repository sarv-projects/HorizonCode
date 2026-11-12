#!/usr/bin/env bash
# Smoke-test NVIDIA NIM using repo-root .env (gitignored). Exits 0 on success.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
strip_cr() { printf '%s' "$1" | tr -d '\r'; }

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
: "${NVIDIA_API_KEY:?set NVIDIA_API_KEY in .env}"
NVIDIA_API_KEY="$(strip_cr "$NVIDIA_API_KEY")"
export HZ_API_KEY="$(strip_cr "${HZ_API_KEY:-$NVIDIA_API_KEY}")"
export HZ_BASE_URL="$(strip_cr "${HZ_BASE_URL:-https://integrate.api.nvidia.com}")"
export HZ_PROVIDER=openai
export HZ_MODEL="$(strip_cr "${HZ_MODEL:-minimaxai/minimax-m3.1-flash}")"

root="${HZ_BASE_URL%/}"
if [[ "$root" == */v1 ]]; then
  models_url="${root}/models"
else
  models_url="${root}/v1/models"
fi

echo "== NVIDIA list models =="
curl -fsS -H "Authorization: Bearer ${NVIDIA_API_KEY}" \
  "$models_url" | head -c 4000
echo ""
echo "== headless turn (optional; HZ_MODEL must be deployed and not EOL) =="
chat_log="$(mktemp)"
trap 'rm -f "$chat_log"' EXIT
set +e
printf 'say exactly: pong\n' | "$ROOT/bin/hzcode" -p 2>&1 | tee "$chat_log" | tail -8
chat_status=${PIPESTATUS[1]}
set -e
if [[ "$chat_status" -ne 0 ]]; then
  if grep -q 'HTTP 410' "$chat_log" 2>/dev/null; then
    echo "(chat EOL: HZ_MODEL in .env is retired — pick a current id from the models list)" >&2
  elif grep -q 'HTTP 404' "$chat_log" 2>/dev/null; then
    echo "(chat 404: function not deployed — try: bash ops/nvidia-chat-probe.sh <deployed-model-id>)" >&2
  else
    echo "(chat failed — models list succeeded; fix HZ_MODEL / keys and retry)" >&2
  fi
  exit 0
fi
