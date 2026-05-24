#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${PROPR_WORKSPACE:-$(pwd)}"

cd "$WORKSPACE/docs"
npm ci
npm run typecheck
npm run build
