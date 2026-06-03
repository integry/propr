#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${PROPR_WORKSPACE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PROPR_CACHE_DIR="${PROPR_CACHE_DIR:-/tmp/propr-setup-cache}"

cd "$WORKSPACE"

export npm_config_cache="$PROPR_CACHE_DIR/npm"
mkdir -p "$npm_config_cache"
npm ci
npm run build --workspace packages/shared
npm run build --workspace packages/core

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to validate the docs site." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Docs validation requires Node.js 20+ because the Docusaurus site depends on packages with a Node 20 runtime floor. Current version: $(node -v)" >&2
  exit 1
fi

cd "$WORKSPACE/docs"
npm ci
npm run typecheck
npm run build
