#!/bin/bash

set -euo pipefail

if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'Packaged Darwin Connect acceptance requires macOS.' >&2
  exit 1
fi

architecture="${1:-}"
if [[ "$architecture" != 'arm64' && "$architecture" != 'x64' ]]; then
  echo 'Packaged Darwin Connect acceptance requires an explicit supported architecture.' >&2
  exit 1
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/../../.." && pwd -P)"
application="$repository_root/apps/desktop/out/propr-desktop-darwin-$architecture/propr-desktop.app"
signature_verifier="$script_directory/verify-darwin-packaged-connect-signature.mjs"
application_signer="$script_directory/sign-darwin-packaged-connect.mjs"
if [[ ! -d "$application" || ! -f "$signature_verifier" || ! -f "$application_signer" ]]; then
  echo 'Packaged Darwin Connect acceptance artifact is missing.' >&2
  exit 1
fi
cd "$repository_root"

original_keychain_output="$(/usr/bin/security list-keychains -d user)"
original_default="$(/usr/bin/security default-keychain -d user)"
original_keychains=()
while IFS= read -r keychain; do
  keychain="${keychain#"${keychain%%[![:space:]]*}"}"
  keychain="${keychain#\"}"
  keychain="${keychain%\"}"
  if [[ -n "$keychain" ]]; then
    original_keychains+=("$keychain")
  fi
done <<< "$original_keychain_output"
original_default="${original_default#"${original_default%%[![:space:]]*}"}"
original_default="${original_default#\"}"
original_default="${original_default%\"}"

umask 077
keychain_root="$(mktemp -d)"
keychain_path="$keychain_root/propr-packaged-connect-smoke.keychain-db"
root_private_key="$keychain_root/root-private.pem"
root_certificate="$keychain_root/root-certificate.pem"
leaf_private_key="$keychain_root/leaf-private.pem"
leaf_request="$keychain_root/leaf-request.pem"
leaf_certificate="$keychain_root/leaf-certificate.pem"
identity_archive="$keychain_root/identity.p12"
root_config="$keychain_root/root.cnf"
leaf_config="$keychain_root/leaf.cnf"
requirement_proof="$keychain_root/designated-requirement.txt"

cleanup_keychain() {
  local primary_status=$?
  local cleanup_status=0
  trap - EXIT HUP INT TERM
  set +e
  /usr/bin/security remove-trusted-cert "$root_certificate" >/dev/null 2>&1 || cleanup_status=1
  if (( ${#original_keychains[@]} > 0 )); then
    /usr/bin/security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || cleanup_status=1
  else
    /usr/bin/security list-keychains -d user -s >/dev/null 2>&1 || cleanup_status=1
  fi
  if [[ -n "$original_default" ]]; then
    /usr/bin/security default-keychain -d user -s "$original_default" >/dev/null 2>&1 || cleanup_status=1
  fi
  /usr/bin/security delete-keychain "$keychain_path" >/dev/null 2>&1 || cleanup_status=1
  rm -rf -- "$keychain_root" || cleanup_status=1
  unset keychain_password identity_password certificate_serial
  if (( cleanup_status != 0 )); then
    echo 'Packaged Darwin Connect acceptance cleanup failed.' >&2
    if (( primary_status == 0 )); then primary_status=1; fi
  fi
  exit "$primary_status"
}
trap cleanup_keychain EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$root_config" <<'EOF'
[req]
distinguished_name = root_name
x509_extensions = root_extensions
prompt = no

[root_name]
CN = ProPR Packaged Connect CI Root

[root_extensions]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

cat > "$leaf_config" <<'EOF'
[leaf_extensions]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

keychain_password="$(/usr/bin/openssl rand -hex 32)"
identity_password="$(/usr/bin/openssl rand -hex 32)"
certificate_serial="$(/usr/bin/openssl rand -hex 16)"
/usr/bin/openssl req -new -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -config "$root_config" -keyout "$root_private_key" -out "$root_certificate" >/dev/null 2>&1
/usr/bin/openssl req -new -newkey rsa:2048 -sha256 -nodes \
  -subj '/CN=ProPR Packaged Connect CI' \
  -keyout "$leaf_private_key" -out "$leaf_request" >/dev/null 2>&1
/usr/bin/openssl x509 -req -sha256 -days 1 -in "$leaf_request" \
  -CA "$root_certificate" -CAkey "$root_private_key" -set_serial "0x$certificate_serial" \
  -extfile "$leaf_config" -extensions leaf_extensions -out "$leaf_certificate" >/dev/null 2>&1
/usr/bin/openssl pkcs12 -export -inkey "$leaf_private_key" -in "$leaf_certificate" \
  -out "$identity_archive" -passout "pass:$identity_password" >/dev/null 2>&1
identity_sha1="$(/usr/bin/openssl x509 -in "$leaf_certificate" -noout -fingerprint -sha1 \
  | sed -E 's/^.*=//; s/://g')"
if [[ ! "$identity_sha1" =~ ^[A-F0-9]{40}$ ]]; then
  echo 'Disposable Darwin signing certificate fingerprint is invalid.' >&2
  exit 1
fi

/usr/bin/security create-keychain -p "$keychain_password" "$keychain_path"
/usr/bin/security set-keychain-settings -lut 21600 "$keychain_path"
/usr/bin/security unlock-keychain -p "$keychain_password" "$keychain_path"
/usr/bin/security list-keychains -d user -s "$keychain_path"
/usr/bin/security default-keychain -d user -s "$keychain_path"
/usr/bin/security add-trusted-cert -r trustRoot -p codeSign -k "$keychain_path" \
  "$root_certificate" >/dev/null
/usr/bin/security import "$identity_archive" -k "$keychain_path" -P "$identity_password" \
  -T /usr/bin/codesign >/dev/null
/usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "$keychain_password" "$keychain_path" >/dev/null
unset keychain_password identity_password certificate_serial

node "$application_signer" "$application" "$keychain_path" "$identity_sha1"
node "$signature_verifier" establish "$application" "$keychain_path" "$identity_sha1" "$requirement_proof"

npm run smoke:connect-package -w @propr/desktop

node "$signature_verifier" stable "$application" "$keychain_path" "$identity_sha1" "$requirement_proof"
