#!/usr/bin/env bash
set -euo pipefail

cd "$PROPR_WORKSPACE"

export npm_config_cache="$PROPR_CACHE_DIR/npm"
mkdir -p "$npm_config_cache"

npm ci
npm run build --workspace packages/shared
npm run build --workspace packages/core
