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
bounded_runner="$script_directory/run-bounded-darwin-command.mjs"
if [[ ! -d "$application" || ! -f "$signature_verifier" || ! -f "$application_signer"
  || ! -f "$bounded_runner" ]]; then
  echo 'Packaged Darwin Connect acceptance artifact is missing.' >&2
  exit 1
fi
cd "$repository_root"

readonly COMMAND_TIMEOUT_MS=30000
readonly CLEANUP_TIMEOUT_MS=10000
readonly SIGNING_TIMEOUT_MS=180000
readonly JOURNEY_TIMEOUT_MS=240000
readonly TERMINATION_GRACE_MS=5000
readonly MAX_OUTPUT_BYTES=262144

stage_marker() {
  local stage="$1"
  local code="$2"
  case "$stage" in
    KEY_CERTIFICATE_GENERATION|KEYCHAIN_CREATION_SELECTION|IDENTITY_IMPORT|PARTITION_LIST_UPDATE|APPLICATION_SIGNING|INITIAL_SIGNATURE_VERIFICATION|PAIR_REPROBE_JOURNEY|STABLE_SIGNATURE_VERIFICATION|KEYCHAIN_RESTORATION_DELETION|TEMPORARY_FILE_CLEANUP) ;;
    *) return 1 ;;
  esac
  case "$code" in
    STARTED|PASSED|FAILED) ;;
    *) return 1 ;;
  esac
  printf 'DARWIN_PACKAGED_CONNECT_SETUP:%s:%s\n' "$stage" "$code"
}

run_bounded() {
  local timeout_ms="$1"
  shift
  node "$bounded_runner" --timeout-ms "$timeout_ms" \
    --termination-grace-ms "$TERMINATION_GRACE_MS" \
    --max-output-bytes "$MAX_OUTPUT_BYTES" --forward-output false -- "$@"
}

run_bounded_forward() {
  local timeout_ms="$1"
  shift
  node "$bounded_runner" --timeout-ms "$timeout_ms" \
    --termination-grace-ms "$TERMINATION_GRACE_MS" \
    --max-output-bytes "$MAX_OUTPUT_BYTES" --forward-output true -- "$@"
}

run_stage() {
  local stage="$1"
  shift
  active_stage="$stage"
  stage_marker "$stage" STARTED
  if "$@"; then
    stage_marker "$stage" PASSED
    active_stage=''
    return 0
  else
    local stage_status=$?
    stage_marker "$stage" FAILED
    active_stage=''
    return "$stage_status"
  fi
}

umask 077
keychain_root=''
keychain_path=''
leaf_private_key=''
leaf_certificate=''
identity_archive=''
leaf_config=''
requirement_proof=''
initial_certificate_prefix=''
stable_certificate_prefix=''
identity_sha1=''
original_default=''
original_keychains=()
keychain_created=0
keychain_state_captured=0
active_stage=''

restore_and_delete_keychain() {
  local restore_status=0
  if (( keychain_state_captured != 0 )); then
    if (( ${#original_keychains[@]} > 0 )); then
      run_bounded "$CLEANUP_TIMEOUT_MS" /usr/bin/security list-keychains -d user -s \
        "${original_keychains[@]}" || restore_status=1
    else
      run_bounded "$CLEANUP_TIMEOUT_MS" /usr/bin/security list-keychains -d user -s \
        || restore_status=1
    fi
    if [[ -n "$original_default" ]]; then
      run_bounded "$CLEANUP_TIMEOUT_MS" /usr/bin/security default-keychain -d user -s \
        "$original_default" || restore_status=1
    fi
  fi
  if (( keychain_created != 0 )); then
    run_bounded "$CLEANUP_TIMEOUT_MS" /usr/bin/security delete-keychain "$keychain_path" \
      || restore_status=1
  fi
  return "$restore_status"
}

remove_temporary_files() {
  if [[ -z "$keychain_root" ]]; then return 0; fi
  run_bounded "$CLEANUP_TIMEOUT_MS" /bin/rm -rf -- "$keychain_root"
}

cleanup_keychain() {
  local primary_status=$?
  local cleanup_status=0
  trap - EXIT HUP INT TERM
  set +e
  run_stage KEYCHAIN_RESTORATION_DELETION restore_and_delete_keychain || cleanup_status=1
  run_stage TEMPORARY_FILE_CLEANUP remove_temporary_files || cleanup_status=1
  unset keychain_password identity_password
  if (( cleanup_status != 0 )); then
    echo 'Packaged Darwin Connect acceptance cleanup failed.' >&2
    if (( primary_status == 0 )); then primary_status=1; fi
  fi
  exit "$primary_status"
}

exit_for_signal() {
  local exit_code="$1"
  if [[ -n "$active_stage" ]]; then
    stage_marker "$active_stage" FAILED
    active_stage=''
  fi
  exit "$exit_code"
}
trap cleanup_keychain EXIT
trap 'exit_for_signal 129' HUP
trap 'exit_for_signal 130' INT
trap 'exit_for_signal 143' TERM

create_and_select_keychain() {
  local original_keychain_output
  original_keychain_output="$(run_bounded_forward "$COMMAND_TIMEOUT_MS" \
    /usr/bin/security list-keychains -d user)" || return $?
  while IFS= read -r keychain; do
    keychain="${keychain#"${keychain%%[![:space:]]*}"}"
    keychain="${keychain#\"}"
    keychain="${keychain%\"}"
    if [[ -n "$keychain" ]]; then original_keychains+=("$keychain"); fi
  done <<< "$original_keychain_output"
  original_default="$(run_bounded_forward "$COMMAND_TIMEOUT_MS" \
    /usr/bin/security default-keychain -d user)" || return $?
  original_default="${original_default#"${original_default%%[![:space:]]*}"}"
  original_default="${original_default#\"}"
  original_default="${original_default%\"}"
  keychain_state_captured=1
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/security create-keychain \
    -p "$keychain_password" "$keychain_path" || return $?
  keychain_created=1
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/security set-keychain-settings \
    -lut 21600 "$keychain_path" || return $?
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/security unlock-keychain \
    -p "$keychain_password" "$keychain_path" || return $?
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/security list-keychains \
    -d user -s "$keychain_path" || return $?
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/security default-keychain \
    -d user -s "$keychain_path"
}

generate_key_and_certificates() {
  local fingerprint_output
  keychain_root="$(run_bounded_forward "$COMMAND_TIMEOUT_MS" /usr/bin/mktemp -d)" || return $?
  [[ -n "$keychain_root" ]] || return 1
  keychain_path="$keychain_root/propr-packaged-connect-smoke.keychain-db"
  leaf_private_key="$keychain_root/leaf-private.pem"
  leaf_certificate="$keychain_root/leaf-certificate.pem"
  identity_archive="$keychain_root/identity.p12"
  leaf_config="$keychain_root/leaf.cnf"
  requirement_proof="$keychain_root/designated-requirement.txt"
  # The private-root cleanup removes every file emitted for both extraction prefixes.
  initial_certificate_prefix="$keychain_root/initial-certificate-"
  stable_certificate_prefix="$keychain_root/stable-certificate-"
  keychain_password="$(run_bounded_forward "$COMMAND_TIMEOUT_MS" \
    /usr/bin/openssl rand -hex 32)" || return $?
  identity_password="$(run_bounded_forward "$COMMAND_TIMEOUT_MS" \
    /usr/bin/openssl rand -hex 32)" || return $?
  builtin printf '%s\n' '[req]' 'distinguished_name = leaf_name' \
    'x509_extensions = leaf_extensions' 'prompt = no' '' '[leaf_name]' \
    'CN = ProPR Packaged Connect CI' '' '[leaf_extensions]' \
    'basicConstraints = critical,CA:FALSE' 'keyUsage = critical,digitalSignature' \
    'extendedKeyUsage = critical,codeSigning' 'subjectKeyIdentifier = hash' \
    'authorityKeyIdentifier = keyid:always,issuer' > "$leaf_config" || return $?

  # A self-signed leaf makes the disposable PKCS#12 chain complete without modifying trust.
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/openssl req -new -x509 -newkey rsa:2048 \
    -sha256 -nodes -days 1 -config "$leaf_config" -keyout "$leaf_private_key" \
    -out "$leaf_certificate" || return $?
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/openssl pkcs12 -export \
    -inkey "$leaf_private_key" -in "$leaf_certificate" -out "$identity_archive" \
    -passout "pass:$identity_password" || return $?
  fingerprint_output="$(run_bounded_forward "$COMMAND_TIMEOUT_MS" /usr/bin/openssl x509 \
    -in "$leaf_certificate" -noout -fingerprint -sha1)" || return $?
  identity_sha1="${fingerprint_output##*=}"
  identity_sha1="${identity_sha1//:/}"
  if [[ ! "$identity_sha1" =~ ^[A-F0-9]{40}$ ]]; then
    echo 'Disposable Darwin signing certificate fingerprint is invalid.' >&2
    return 1
  fi
}

import_identity() {
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/security import "$identity_archive" \
    -k "$keychain_path" -P "$identity_password" -T /usr/bin/codesign
}

update_partition_list() {
  run_bounded "$COMMAND_TIMEOUT_MS" /usr/bin/security set-key-partition-list \
    -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path"
}

sign_application() {
  run_bounded_forward "$SIGNING_TIMEOUT_MS" node "$application_signer" \
    "$application" "$keychain_path" "$identity_sha1"
}

verify_initial_signature() {
  run_bounded_forward "$COMMAND_TIMEOUT_MS" node "$signature_verifier" establish \
    "$application" "$identity_sha1" "$requirement_proof" "$initial_certificate_prefix"
}

run_pair_and_reprobe() {
  run_bounded_forward "$JOURNEY_TIMEOUT_MS" npm run smoke:connect-package -w @propr/desktop
}

verify_stable_signature() {
  run_bounded_forward "$COMMAND_TIMEOUT_MS" node "$signature_verifier" stable \
    "$application" "$identity_sha1" "$requirement_proof" "$stable_certificate_prefix"
}

run_stage KEY_CERTIFICATE_GENERATION generate_key_and_certificates
run_stage KEYCHAIN_CREATION_SELECTION create_and_select_keychain
run_stage IDENTITY_IMPORT import_identity
run_stage PARTITION_LIST_UPDATE update_partition_list
unset keychain_password identity_password
run_stage APPLICATION_SIGNING sign_application
run_stage INITIAL_SIGNATURE_VERIFICATION verify_initial_signature
run_stage PAIR_REPROBE_JOURNEY run_pair_and_reprobe
run_stage STABLE_SIGNATURE_VERIFICATION verify_stable_signature
