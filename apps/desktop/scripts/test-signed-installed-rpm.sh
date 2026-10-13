#!/usr/bin/env bash
set -euo pipefail
test "$(uname -m)" = x86_64
rpm_file=/input/preview.rpm
test "$(sha256sum "$rpm_file" | cut -d" " -f1)" = "$PROPR_RPM_SHA256"
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
rpmkeys --checksig --verbose "$rpm_file" > /tmp/signature-check
node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
import { assertRpmSignatures } from './apps/desktop/scripts/rpm-signing.mjs';
assertRpmSignatures(readFileSync('/tmp/signature-check', 'utf8'), process.env.PROPR_RPM_FINGERPRINT);
NODE
test "$(rpm -qp --qf '%{ARCH}' "$rpm_file")" = x86_64
# No repository access is necessary at runtime: dependencies are in the image.
# Disable configured repositories while leaving zypper's temporary local RPM cache usable.
zypper --non-interactive modifyrepo --disable --all > /tmp/install-log 2>&1
zypper --non-interactive --no-refresh install "$rpm_file" >> /tmp/install-log 2>&1
rpm -V propr-desktop > /tmp/verify
! test -s /tmp/verify
rpm -qp --dump "$rpm_file" > /tmp/artifact-dump
rpm -q --dump propr-desktop > /tmp/installed-dump
cmp /tmp/artifact-dump /tmp/installed-dump
node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
import { validateDesktopRuntimeManifest } from './apps/desktop/scripts/desktop-runtime-manifest.mjs';
validateDesktopRuntimeManifest(JSON.parse(readFileSync('/usr/lib/propr-desktop/resources/manifest.json')), {
  sourceRevision: process.env.PROPR_RPM_SOURCE_SHA, distribution: 'published',
});
NODE
mkdir -p /evidence
chown -R acceptance:acceptance /evidence
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
cp -a /tmp/desktop-acceptance-artifacts /tmp/pairing-evidence /tmp/browser.json /evidence/
# A post-launch verification detects package mutation during acceptance too.
rpm -V propr-desktop > /tmp/verify
! test -s /tmp/verify

test "$(sha256sum "$rpm_file" | cut -d" " -f1)" = "$PROPR_RPM_SHA256"
