# Linux package authentication

New public Linux previews authenticate **both DEB and RPM packages, on x64 and
arm64**. The owner identity for previews signed on or after 2026-10-19 is
**80FE0A7667A92A0AD3CEAE6D4C2FF8C3CC4E1599** (`ProPR Desktop Release Signing`,
RSA4096, expires 2028-10-18). It replaces
DD4E7F65CE2345A1F4597D643CF856B53093D3A3, whose passphrase is no longer available;
no compromise has been reported, the old key is not revoked, and it has not
cross-signed the new one. See the independent [release-key notice, rotation details and public
downloads](linux-release-key.md).

The main-only `desktop-linux-signed-preview.yml` consumes the exact finalized
four-package artifact from a successful main-dispatched unsigned preview run.
Reviewed main control code signs; the frozen source is data for native pins only.
Original unsigned inputs remain intact. DEBs stay byte-for-byte unchanged; RPM
signing changes only their signature region, preserving the entire main header
and payload. Native architecture, hash pins, root-owned 4755 sandbox metadata,
and source/app/UI/agent runtime digests are rechecked before and after signing.

## Protected boundary

Reuse the existing owner-provisioned `desktop-linux-rpm-signing` environment.
Its compatibility names remain unchanged:

| Setting | Purpose |
| --- | --- |
| `PROPR_DESKTOP_RPM_SIGNING_AUTHORIZED` | Protected authorization, `1` |
| `PROPR_DESKTOP_RPM_PRIVATE_KEY` | Existing protected private key secret |
| `PROPR_DESKTOP_RPM_PASSPHRASE` | Existing protected passphrase secret |
| `PROPR_DESKTOP_RPM_PUBLIC_KEY` | Repository variable containing the public export |
| `PROPR_DESKTOP_RPM_FINGERPRINT` | Repository variable with the complete owner fingerprint |

The code pin `OWNER_FINGERPRINT` in `apps/desktop/scripts/rpm-signing.mjs` is the
reviewed source of truth. Signing refuses to start unless
`PROPR_DESKTOP_RPM_FINGERPRINT` equals it exactly, the public export imports as
exactly that one unexpired, unrevoked RSA signing primary key, and the private key
matches it. For the 2026-10-19 rotation a human administrator separately replaces
the protected private-key and passphrase secrets and sets both public settings to
`80FE0A7667A92A0AD3CEAE6D4C2FF8C3CC4E1599` and the export in
`docs/static/keys/propr-desktop-release.asc`. Until then signing fails closed;
there is no fallback to the previous identity.

Private credentials are confined to the protected read-only signing job. The
entry point removes them from the environment before package parsers run. GnuPG
uses temporary private files, scrubbed subprocess environments, exact-primary
selection, bounded diagnostics, and cleanup. Stage/publication jobs have public
inputs only. No keys, permissions, hosting, or access are provisioned by this work.

## Authentication graph

Schema 4 has trust `authenticated-linux-preview`, tag suffix `-all-signed`, and
title suffix **(authenticated DEB and RPM)**. `rpmSigning.originals` records the
unsigned RPM hash and preserved main-header/payload digest; `signing.originalDebs`
records unchanged DEB hashes. Source and original workflow-run bindings remain in
the authenticated manifest.

1. Final native RPM header and header+payload signatures are verified in an
   isolated RPM database containing only the pinned public identity.
2. `APT-Packages-amd64` and `APT-Packages-arm64` describe the final DEBs, including
   their real dependency fields, sizes and SHA256 hashes.
3. `APT-Release` binds both indexes by SHA256 and size; `APT-InRelease` and
   `APT-Release.gpg` each authenticate those exact Release bytes with the pinned
   primary key. Metadata expires after 30 days.
4. Final `SHA256SUMS` covers all four packages, `linux-preview.json`, `INSTALL.md`,
   and all five APT assets. `SHA256SUMS.asc` is its detached armored signature.
   Neither the checksum file nor its detached signature hashes itself. There is
   no circular dependency or unauthenticated checksum claim.

Canonical stage and publication verification require the exact 13-file allowlist,
all hashes, both APT signatures, the complete Release → Packages → DEB chain, both
native RPM signatures, and the source/runtime/payload checks. Missing, extra,
duplicate, symlinked, changed, expired or wrong-key assets fail closed. No RPM-only
fallback is available.

## Direct downloads

Download every asset into a fresh directory. Obtain the public export through the
independent notice, inspect its full primary fingerprint, and use isolated trust:

```sh
KEYHOME="$(mktemp -d)"
chmod 700 "$KEYHOME"
gpg --homedir "$KEYHOME" --import propr-desktop-release.asc
gpg --homedir "$KEYHOME" --with-colons --fingerprint
# Require exactly one primary key with the full fingerprint in the notice.
gpg --homedir "$KEYHOME" --verify SHA256SUMS.asc SHA256SUMS
# Stop on errors, a different signer, expiry, or revocation.
sha256sum --check SHA256SUMS
```

Only after both checks succeed, follow the authenticated `INSTALL.md`. This
explicitly authenticates direct DEB downloads; `apt install ./package.deb` alone
does not establish that provenance. RPM users additionally require both native
signatures with `rpmkeys --checksig --verbose`. Use
`dnf --setopt=localpkg_gpgcheck=1` or ordinary `zypper install` after bootstrapping
the confirmed RPM key. After the 2026-10-19 rotation, import the new public key
(both signature lines must report key ID `cc4e1599`); a database holding only the
previous key reports `NOKEY` for new RPMs. Never override a missing key or failed
signature.

## Exported APT repository

This release supplies a **repository bundle**, not a live hosted APT endpoint.
Authenticated `INSTALL.md` contains exact assembly commands: map APT-Release,
APT-InRelease and APT-Release.gpg to `dists/preview/`; map each architecture index
to `dists/preview/main/binary-<architecture>/Packages`; copy the unchanged DEBs
into `pool/`. Verify both Release signatures, including equality of the plaintext
recovered from InRelease. Use a source-scoped binary or armored public keyring:

```text
deb [signed-by=/absolute/path/propr-desktop-release.gpg] file:/absolute/path/apt-repository preview main
```

After the 2026-10-19 rotation, point `signed-by=` at a keyring containing the new
key only; a keyring holding just the previous key correctly rejects new metadata.
The keyring and repository must be readable by APT. A locally served copy can use
a local HTTP URL with the same scoped keyring. There is no production URL to
configure. Run `apt update` before downloading, and stop on authentication/hash
errors. APT authenticates signed repository metadata and package hashes; it does
not check an embedded DEB signature. See Debian's
[apt-secure documentation](https://manpages.debian.org/bookworm/apt/apt-secure.8.en.html)
and [repository format](https://wiki.debian.org/DebianRepository/Format).

## Operator review and historical releases

After integration, the operator independently reviews the exact main head and
selects a frozen source and successful unsigned `stage-draft` run. Dispatch
`sign-draft` in the authenticated workflow with those inputs. Review its distinct
signed draft before separately authorizing `publish-draft` with the same source.
Publication uses the existing `desktop-linux-preview-publication` environment and
`PROPR_DESKTOP_LINUX_PREVIEW_PUBLICATION_AUTHORIZED` gate. It never promotes latest
or stable, and Linux self-update remains disabled.

Resume failed staging with the same `propr-desktop-linux-signed-<run-id>` artifact.
Do not re-sign or overwrite an existing candidate: signatures can change bytes.
Unavailable inputs require a new explicitly selected source/run, not a fallback.

Rotation does not change history. Any preview already signed by
DD4E7F65CE2345A1F4597D643CF856B53093D3A3 keeps its immutable assets, signatures and
original classification; verify it with the [historical public
export](/keys/propr-desktop-release-historical-DD4E7F65CE2345A1F4597D643CF856B53093D3A3.asc).
The new code pin and key verify only previews signed on or after 2026-10-19 and do
not authenticate older releases.

Unsigned schema 2 remains private validation evidence and cannot be newly
published. Historical schema 3 (`rpm-signed-preview`, `-rpm-signed`) authenticated
RPMs only; its DEBs and claimed checksums were unsigned. Historical immutable
assets remain unchanged and must retain that classification. They cannot satisfy
schema 4 publication. Existing source529d9fb image publication and private unsigned
installer staging remain separate evidence. ARM managed-agent limitations still
apply; signing is not end-to-end runtime acceptance.

## Required regression tests

```sh
PROPR_REQUIRE_RPM_TESTS=1 node --test apps/desktop/scripts/rpm-signing.test.mjs \
  apps/desktop/scripts/linux-preview-release.test.mjs \
  apps/desktop/scripts/linux-preview-workflow.test.mjs
```

CI installs GnuPG, RPM tools, cpio, dpkg and APT and requires real disposable-key
coverage; missing tools fail rather than skip. Tests cover both architectures,
unchanged DEBs, native RPM preservation/signatures, signed checksums, both APT
signatures, tampering and publication rejection. Real loopback HTTP APT update and
download tests use isolated source lists, keyrings, status, cache and download
directories, including successful detached-signature fallback and tamper rejection.
They neither install packages nor alter host trust. Backup, revocation, rotation,
and maintainer contact procedures are in the [key notice](linux-release-key.md).

## Required installed x64 RPM browser acceptance

`sign-draft` now downloads `propr-desktop-linux-signed-<signing-run-id>` into a
separate read-only acceptance job. It does not rebuild or re-sign the package.
The job builds a disposable openSUSE Leap 16.0 test image, removes its bootstrap
RPM keys, imports only the configured ProPR key, verifies both native RPM
signatures, installs with ordinary noninteractive `zypper`, and requires clean
`rpm -V` before and after execution. The installed file metadata must equal the
artifact metadata, and the installed runtime manifest must carry the selected
source SHA. No host RPM database, home, desktop profile, or keyring is mounted.

The test runs `/usr/lib/propr-desktop/propr-desktop` as a fresh unprivileged user
with private profiles and Secret Service. Playwright controls its real renderer
through CDP and the existing authorized main/preload boundary. Polling remains
pending until Playwright opens the fixture server's approval URL and submits an
explicit approval in that browser page. Activation also refuses unapproved
requests. The accepted synthetic identity is checked by the existing
acceptance-only account confirmation predicate; production authentication is
unchanged. The installed test checks live authenticated UI, process restart using
the persisted credential without another pairing, logout/revocation, and another
restart without credentials. Rejection, a short monotonic approval deadline, and
a different account must leave no usable persisted credential; wrong-account
rollback cancels its provisional activation.

The container runs on its own disposable Docker `--internal` bridge with no
external egress. Its active interface keeps Chromium's `navigator.onLine` true
while acceptance services remain on loopback. It uses `--shm-size=1g` for Electron
screenshot capture. Browser-page routing also rejects other origins. No stored GitHub
credentials, real OAuth, production instance, interactive installation, or live
test account is needed. The existing full packaged visual/axe suite runs against
this installed executable. Additional login and approval-page images check
keyboard focus and visible controls at narrow desktop width and 200% layout zoom,
using actual Tab navigation before requiring a `:focus-visible` ring.
Electron uses its measured web-frame zoom; the fixture browser page uses CSS
layout zoom, labeled separately in `pairing-evidence/usability.json`. A narrow
desktop window is not phone coverage.

To reproduce locally on a native Linux x64 host with a native x64 Docker daemon,
Node 22.15 or later, RPM tools and GnuPG, download the exact artifact from the
signing run. Use the public key export and full fingerprint from the independent
key notice. Run from the repository root, with a new output directory:

```sh
# SIGNING_RUN_ID, SOURCE_SHA and VERSION identify the selected signing artifact.
gh run download "$SIGNING_RUN_ID" \
  --name "propr-desktop-linux-signed-$SIGNING_RUN_ID" --dir signed-preview
export PROPR_DESKTOP_RPM_PUBLIC_KEY="$(cat propr-desktop-release.asc)"
export PROPR_DESKTOP_RPM_FINGERPRINT=80FE0A7667A92A0AD3CEAE6D4C2FF8C3CC4E1599
PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE=1 \
  node apps/desktop/scripts/run-signed-installed-rpm-acceptance.mjs \
  --rpm "signed-preview/ProPR-Desktop-$VERSION-linux-x64.rpm" \
  --source-revision "$SOURCE_SHA" --signing-run-id "$SIGNING_RUN_ID" \
  --output signed-rpm-acceptance
```

The explicit opt-in permits only disposable package-manager containers. The test
uses `SYS_ADMIN` for Chromium sandbox namespaces and `IPC_LOCK` for the synthetic
keyring inside that container. It retains no raw process output or credential
material. Failed installation, sandbox/keyring limitations, failed tests, and
interruption emit no passed evidence. The owned container and image are cleaned
up along with its owned internal network. Image construction needs
registry/package/dependency access; installed acceptance has no external egress.

CI retains the bounded `signed-rpm-acceptance.json` as
`propr-desktop-installed-signed-rpm-<signing-run-id>`, and visual/accessibility
artifacts separately with a `-visual-` name. The strict report binds all required
checks to the exact final signed RPM SHA256, source SHA, public-key fingerprint,
and signing run. Staging depends on the acceptance job. Protected `publish-draft`
requires `signing_run_id` in addition to the same frozen source. Publication
re-downloads and verifies the draft packages, checks the report against those
bytes, verifies successful main-dispatched signing-run provenance, and retrieves
the authoritative evidence artifact through the Actions API. Its archive digest
and report must match the supplied evidence. Missing, expired, failed, forged,
other-source, other-key, other-run or other-RPM evidence rejects publication.
Protected private draft/preview controls and `make_latest: false` remain in place.
Expired evidence requires a new candidate/signing run, never a silent waiver.

Run the focused regressions with:

```sh
node --test apps/desktop/scripts/packaged-browser-approval.test.mjs \
  apps/desktop/scripts/signed-rpm-acceptance-evidence.test.mjs \
  apps/desktop/scripts/linux-preview-workflow.test.mjs
npx tsx --test apps/desktop/scripts/packaged-acceptance-account.test.mjs
# With Playwright Chromium installed (also run by the acceptance image build):
node --test apps/desktop/scripts/packaged-browser-approval.playwright.mjs
PROPR_REQUIRE_RPM_TESTS=1 node --test apps/desktop/scripts/rpm-signing.test.mjs
```

The account regression needs the normal workspace dependencies and built shared
and client packages. The native signing/publication regression additionally uses
cpio, dpkg, APT and Python 3. Live GitHub smoke remains a separate optional task;
this gate provides no claim of live OAuth coverage or ARM64 installed acceptance.
