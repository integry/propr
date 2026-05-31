#!/usr/bin/env sh
set -e

PROPR_WORKSPACE="${PROPR_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
PROPR_CACHE_DIR="${PROPR_CACHE_DIR:-/tmp/propr-setup-cache}"

cd "$PROPR_WORKSPACE"

export npm_config_cache="$PROPR_CACHE_DIR/npm"
mkdir -p "$npm_config_cache"

npm ci
npm run build --workspace packages/shared
npm run build --workspace packages/core
