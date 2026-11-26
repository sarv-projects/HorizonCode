#!/usr/bin/env bash
# Smoke-test NVIDIA NIM using NVIDIA_API_KEY from process env. Exits 0 on success.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
strip_cr() { printf '%s' "$1" | tr -d '\r'; }

if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  echo "usage: NVIDIA_API_KEY=<key> [HZ_MODEL=<model>] [HZ_BASE_URL=<url>] $0" >&2
  echo "  NVIDIA_API_KEY must be set in the process environment (this script does not source .env)" >&2
  exit 2
fi

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

models_body="$(mktemp)"
chat_log="$(mktemp)"
cleanup() {
  rm -f "$models_body" "$chat_log"
}
trap cleanup EXIT

echo "== NVIDIA list models =="
curl -fsS -H "Authorization: Bearer ${NVIDIA_API_KEY}" \
  -o "$models_body" "$models_url"
head -c 4000 "$models_body"
echo ""
echo "== headless turn (HZ_MODEL must be deployed and not EOL) =="
set +e
printf 'say exactly: pong\n' | "$ROOT/bin/hzcode" -p 2>&1 | tee "$chat_log" | tail -8
chat_status=${PIPESTATUS[1]}
set -e
if [[ "$chat_status" -ne 0 ]]; then
  if grep -q 'HTTP 410' "$chat_log" 2>/dev/null; then
    echo "(chat EOL: HZ_MODEL is retired — pick a current id from the models list)" >&2
  elif grep -q 'HTTP 404' "$chat_log" 2>/dev/null; then
    echo "(chat 404: function not deployed — try: bash ops/nvidia-chat-probe.sh <deployed-model-id>)" >&2
  else
    echo "(chat failed — models list succeeded; fix HZ_MODEL / keys and retry)" >&2
  fi
  exit "$chat_status"
fi
