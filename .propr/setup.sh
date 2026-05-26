#!/usr/bin/env sh
set -eu

cd "${PROPR_WORKSPACE:-$(dirname "$0")/..}"
npm ci
npm run build --workspace packages/shared
npm run build --workspace packages/core
