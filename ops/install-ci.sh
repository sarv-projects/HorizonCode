#!/usr/bin/env bash
# Install the GitHub Actions workflow from its tracked payload.
#
# Why this exists: the automation identity pushes with a GitHub App token
# that lacks the `workflow` scope, so a commit touching .github/workflows/
# is rejected by GitHub. The workflow therefore lives as a tracked payload
# (ops/ci/github-actions.yml) and is installed with this one command.
#
# Run it, then commit and push .github/workflows/ci.yml with an identity
# that has the workflow scope (your own login, or a token with it).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/.github/workflows"
cp "$root/ops/ci/github-actions.yml" "$root/.github/workflows/ci.yml"

cat <<'EOF'
installed: .github/workflows/ci.yml

next steps (in a checkout whose token has the `workflow` scope):
  git add .github/workflows/ci.yml
  git commit -m "CI: activate the GitHub Actions workflow"
  git push

until then, run the same gates locally:
  bash ops/gates.sh
EOF
