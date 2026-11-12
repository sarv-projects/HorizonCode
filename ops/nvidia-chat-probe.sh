#!/usr/bin/env bash
# Keyed NVIDIA NIM chat probe for the README §5.11 quality row.
# Exits 0 only when chat/completions returns HTTP 2xx for HZ_MODEL (or the first arg).
# Exits 1 on 404 (function not deployed), 410 (EOL), or other failures — with fix hints.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
strip_cr() { printf '%s' "$1" | tr -d '\r'; }

if [[ "${HZ_PROBE_NO_DOTENV:-}" != "1" && -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

: "${NVIDIA_API_KEY:?set NVIDIA_API_KEY in .env}"
KEY="$(strip_cr "$NVIDIA_API_KEY")"
MODEL="$(strip_cr "${1:-${HZ_MODEL:-}}")"
if [[ -z "$MODEL" ]]; then
  echo "usage: $0 [model-id]" >&2
  echo "  or set HZ_MODEL in .env" >&2
  exit 2
fi

BASE="$(strip_cr "${HZ_BASE_URL:-https://integrate.api.nvidia.com}")"
BASE="${BASE%/}"
URL="${BASE}/v1/chat/completions"
if [[ "$BASE" == */v1 ]]; then
  URL="${BASE}/chat/completions"
fi

body=$(mktemp)
trap 'rm -f "$body"' EXIT
code=$(curl -sS --max-time 120 -o "$body" -w '%{http_code}' \
  -H "Authorization: Bearer ${KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: pong\"}],\"max_tokens\":16}" \
  "$URL")

echo "model=${MODEL} http=${code}"
head -c 400 "$body"
echo ""

case "$code" in
  2??) exit 0 ;;
  410)
    echo "fix: HZ_MODEL is EOL — pick a current id from: bash ops/nvidia-smoke.sh" >&2
    exit 1
    ;;
  404)
    echo "fix: function not deployed for this account — deploy the NIM in NVIDIA AI Enterprise / pick a deployed id" >&2
    exit 1
    ;;
  *)
    echo "fix: check HZ_BASE_URL, key, and model id" >&2
    exit 1
    ;;
esac
