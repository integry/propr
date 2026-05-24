#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
npm ci
npm --workspace @propr/shared run build

if [ ! -f "$ROOT_DIR/.propr/test-private-key.pem" ]; then
  cat <<'EOF' > "$ROOT_DIR/.propr/test-private-key.pem"
-----BEGIN PRIVATE KEY-----
ultrafix-test-key
-----END PRIVATE KEY-----
EOF
fi
