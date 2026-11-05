#!/usr/bin/env bash
set -euo pipefail

# Fixed step names only: the host runner reports the last allowlisted stage on
# failure and discards all other container output.
stage() { printf 'PROPR_RPM_ACCEPTANCE_STAGE=%s\n' "$1"; }

export_evidence() {
  local source_directory=$1 evidence_directory=$2
  [[ ${PROPR_RPM_HOST_UID:?} =~ ^[0-9]+$ && ${PROPR_RPM_HOST_GID:?} =~ ^[0-9]+$ ]]
  # Read private acceptance-owned files as root, but create every exported entry
  # as the invoking host identity. Even a failed/interrupted extraction leaves
  # host-owned private directories that the host can remove. Never chown the bind
  # mount to the fixed acceptance user or preserve archive ownership on export.
  tar -C "$source_directory" -cf - desktop-acceptance-artifacts pairing-evidence browser.json |
    setpriv --reuid="$PROPR_RPM_HOST_UID" --regid="$PROPR_RPM_HOST_GID" --clear-groups \
      bash -euo pipefail -c 'umask 077; exec tar -C "$1" --no-same-owner --no-same-permissions -xf -' bash "$evidence_directory"
}

test "$(uname -m)" = x86_64
stage container-preflight
rpm_file=/input/preview.rpm
test "$(sha256sum "$rpm_file" | cut -d" " -f1)" = "$PROPR_RPM_SHA256"
stage key-trust
# Repository bootstrap keys are discarded after installing the test dependencies.
# The disposable container owns this database; the host RPM database is never mounted.
rpm -qa 'gpg-pubkey*' | xargs -r rpm -e
rm -rf /var/lib/zypp/pubkeys /var/cache/zypp/pubkeys
keyhome=$(mktemp -d)
chmod 700 "$keyhome"
gpg --batch --homedir "$keyhome" --import /input/public.asc >/dev/null 2>&1
actual=$(gpg --batch --homedir "$keyhome" --with-colons --list-keys | awk -F: '$1=="pub"{pub++} $1=="fpr" && pub==1{print $10; exit}')
test "$actual" = "$PROPR_RPM_FINGERPRINT"
test "$(gpg --batch --homedir "$keyhome" --with-colons --list-keys | awk -F: '$1=="pub"{n++} END{print n}')" = 1
rpm --import /input/public.asc
test "$(rpm -qa 'gpg-pubkey*' | wc -l)" = 1
stage signature-verify
rpmkeys --checksig --verbose "$rpm_file" > /tmp/signature-check
node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
import { assertRpmSignatures } from './apps/desktop/scripts/rpm-signing.mjs';
assertRpmSignatures(readFileSync('/tmp/signature-check', 'utf8'), process.env.PROPR_RPM_FINGERPRINT);
NODE
test "$(rpm -qp --qf '%{ARCH}' "$rpm_file")" = x86_64
stage package-install
# No repository access is necessary at runtime: dependencies are in the image.
# Disable configured repositories while leaving zypper's temporary local RPM cache usable.
zypper --non-interactive modifyrepo --disable --all > /tmp/install-log 2>&1
zypper --non-interactive --no-refresh install "$rpm_file" >> /tmp/install-log 2>&1
stage installed-verify
rpm -V propr-desktop > /tmp/verify
! test -s /tmp/verify
rpm -qp --dump "$rpm_file" > /tmp/artifact-dump
rpm -q --dump propr-desktop > /tmp/installed-dump
cmp /tmp/artifact-dump /tmp/installed-dump
stage runtime-manifest
node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
import { validateDesktopRuntimeManifest } from './apps/desktop/scripts/desktop-runtime-manifest.mjs';
validateDesktopRuntimeManifest(JSON.parse(readFileSync('/usr/lib/propr-desktop/resources/manifest.json')), {
  sourceRevision: process.env.PROPR_RPM_SOURCE_SHA, distribution: 'published',
});
NODE
stage browser-acceptance
# Fresh user, private Secret Service, no host home/keyring, no GitHub credentials.
runuser -u acceptance -- env -i PATH="$PATH" HOME=/home/acceptance \
  PLAYWRIGHT_BROWSERS_PATH=/opt/playwright PROPR_DESKTOP_INSTALLED_RPM_ACCEPTANCE=1 \
  PROPR_DESKTOP_ACCEPTANCE_OUTPUT=/tmp/desktop-acceptance-artifacts \
  dbus-run-session -- bash -euo pipefail -c '
    export XDG_DATA_HOME=$(mktemp -d)
    eval "$(printf "%s\n" "synthetic-acceptance-keyring" | gnome-keyring-daemon --unlock --components=secrets)"
    export DISPLAY=:99
    Xvfb :99 -screen 0 1280x820x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
    display_pid=$!
    cleanup_display() { kill "$display_pid" 2>/dev/null || true; }
    trap cleanup_display EXIT
    for attempt in {1..100}; do test -S /tmp/.X11-unix/X99 && break; sleep 0.05; done
    test -S /tmp/.X11-unix/X99
    node apps/desktop/scripts/run-packaged-acceptance.mjs
  '
stage evidence-export
export_evidence /tmp /evidence
stage post-verify
# A post-launch verification detects package mutation during acceptance too.
rpm -V propr-desktop > /tmp/verify
! test -s /tmp/verify

test "$(sha256sum "$rpm_file" | cut -d" " -f1)" = "$PROPR_RPM_SHA256"
