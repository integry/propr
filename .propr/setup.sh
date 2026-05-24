#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
npm ci
npm --workspace @propr/shared run build

if [ ! -f "$ROOT_DIR/.propr/test-private-key.pem" ]; then
  # Generate an ephemeral local-only test key instead of checking private key material into the repo.
  umask 077
  node - "$ROOT_DIR/.propr/test-private-key.pem" <<'EOF'
const { generateKeyPairSync } = require('node:crypto');
const { chmodSync, writeFileSync } = require('node:fs');

const outputPath = process.argv[2];
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync(outputPath, privateKey, { mode: 0o600 });
chmodSync(outputPath, 0o600);
EOF
  chmod 600 "$ROOT_DIR/.propr/test-private-key.pem"
fi
