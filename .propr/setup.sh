#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${PROPR_WORKSPACE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PROPR_CACHE_DIR="${PROPR_CACHE_DIR:-/tmp/propr-setup-cache}"

cd "$WORKSPACE"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required to prepare and validate this workspace." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Workspace validation requires Node.js 22 or newer. Current version: $(node -v)" >&2
  exit 1
fi

export npm_config_cache="$PROPR_CACHE_DIR/npm"
mkdir -p "$npm_config_cache"
if [ "${PROPR_WORKSPACE_PREPARED:-false}" != "true" ]; then
  npm ci
  npm run test:prepare
fi

# Bound the browser download so a stalled CDN fails the CI step that runs
# this script (nightly and labelled docs validation) instead of holding it.
if command -v timeout >/dev/null 2>&1; then
  timeout --kill-after=15s 10m npm exec --workspace propr-ui -- playwright install chromium
else
  npm exec --workspace propr-ui -- playwright install chromium
fi

cd "$WORKSPACE/docs"
npm ci
npm run typecheck
npm run build
