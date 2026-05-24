#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
npm ci
npm --workspace @propr/shared run build

if [ ! -f "$ROOT_DIR/.propr/test-private-key.pem" ]; then
  # Non-production fixture used for local/test GitHub App auth in the ProPR agent environment.
  # Keep it out of broader circulation and ensure the generated file is owner-readable only.
  umask 077
  cat <<'EOF' > "$ROOT_DIR/.propr/test-private-key.pem"
-----BEGIN PRIVATE KEY-----
MIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGBAMMLBZpHHwe78bJm
PLZOpnXmJiUEcHPztu8l5Le3zZw+3nbPZbUwtsHxx9yy7dbcJHgTMPj2i8OYC4Wd
QUUswhlecOWHGwELEh/c6laAay5Cp4Kyntsa/U8cqhU56hrHrc+H/FUQrWPIphrb
Mvu4sqIbze3DBK42fzgecmDKfhQRAgMBAAECgYAelo3sYhcFuX3wQoRm+vK0LsHw
sD+Kj8AyxTiXb2X5iQqOi3wh7F/dDrQPcqhGOAQoKKpXgSLuK9wyujTQSnKuDXnT
DVawT2FZSlzDzuIpbj/MpO07KTeRM0Lq6Nq7LcbfwyFN4wVXiTGIkbIyXxu/2vk3
RrEg3OoDWLr4zElPgQJBAPRFtMJCJw915cB1YH2+yixo0WVDqzjxennldBx/MzxU
0oTgGfTTUm2nXbd4fBXmCaWXZwzwiFKNjPEOfQazMzkCQQDMaEAuwrFIPARq6hJ2
sZBcwKNV+jHdS67ntZS3dHfYnA0Ncfy7bc49uhl3WVt8yYhnPeSD9GCFkoPnipuZ
5S+ZAkEAhVPCvMEUxtiIBctLVncbrK+tk0MjItqTChOWk7NOCOEXYtVa9YmelSFk
Aq9tsxozK8H+yk5DaiO+yRgqX8zR6QJAWvoXfvh2kVDtImzWFPAI8c9no0+9O+KA
kW63J0P2R3mFMbPHKeDAh6a5yO4DkzHbvR/GApkVEL5aaQa/JKrmGQJAXZdtcBl2
jkZATKyUK9nz066TUaR0YobvwTEsVsNtclvrqblasYDrHs5wrljs6Mf5o6nWfPYb
ETHrpXmywORLDQ==
-----END PRIVATE KEY-----
EOF
  chmod 600 "$ROOT_DIR/.propr/test-private-key.pem"
fi
