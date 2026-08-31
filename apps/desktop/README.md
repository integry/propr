# ProPR Desktop

This workspace packages the existing `propr-ui` React source as a sandboxed Electron renderer. The desktop entry is
`propr-ui/src/desktop.tsx`; the normal web entry, service worker, CLI, API, and self-hosted deployment remain unchanged.

## Commands

Run these from the repository root:

```sh
npm run desktop:dev
npm run desktop:typecheck
npm run desktop:test
npm run desktop:package
npm run desktop:smoke # Run under xvfb-run on a headless Linux host.
npm run desktop:make
npm run desktop:audit
# On Linux hosts with the corresponding native packaging tools installed:
npm run make:deb -w @propr/desktop
npm run make:rpm -w @propr/desktop
# macOS only, after packaging the selected architecture:
npm run make:dmg -w @propr/desktop -- --arch=arm64
```

Desktop development, typecheck, package, and make commands build required renderer workspace dependencies through
`desktop:prepare`, in dependency order (`@propr/shared` then `@propr/client`). They do not depend on previously
generated workspace `dist` directories.

Development renderer URLs are accepted only when Electron Forge supplies an HTTP loopback URL. Packaged builds load
the generated renderer from the application ASAR through an app-owned protocol.

The packaged-binary smoke test verifies the hardened fuse states and launches artifacts without a sandbox-disabling
flag. Its preferred window is 1280x820 with an 880x620 minimum; native evidence requires the actual window to equal
that preferred size clamped to the renderer-reported available work area, and derives the viewport from the actual
native content bounds. It retains the real title-bar logo, connection-card, control containment, sizing, spacing, and
footer checks on smaller responsive work areas. The child receives only fixed smoke triggers, private profile/temp
paths, and strictly validated platform launch inputs; it never inherits the parent CI environment or `PATH`. The smoke
also rejects main-process uncaught exceptions and requires proof that `window.proprDesktop` is exposed before a clean
exit. `desktop:smoke:inspect` performs executable and fuse inspection without launching a window. Release CI launches
both Linux architectures under Xvfb, inspects macOS and Windows packages on their native runners, validates
DMG/ZIP/DEB/RPM/MSI packages, and validates configured OS signatures.

The first-release Windows MVP packages only the normal desktop application. Native self-update installation authority
is deferred to issue #2000: no broker, bootstrap, launcher, service, or authority custom action is built, copied into
`resources`, or installed by the MSI. Both Windows architectures remain mandatory release targets, and package/MSI
inspection fails if any deferred authority resource appears.

`desktop:audit` deliberately applies separate policies to the two dependency surfaces: low-or-higher advisories fail
the production-runtime audit, while high and critical advisories fail the desktop development/build-tool audit. Release
CI runs both checks directly from the committed lockfile before installing or executing the packaging toolchain.

## Security boundary

The renderer has no Node.js integration and receives only the typed `window.proprDesktop` bridge. It exposes metadata,
validated external-browser opening, profiles, encrypted credentials, lifecycle placeholders, and validated deep-link
events. It never exposes a shell, command runner, arbitrary IPC call, or filesystem path/API.

Profile metadata is stored in an app-owned, permission-restricted JSON file. Credential values are encrypted with
Electron `safeStorage` before they are written separately. If OS encryption is unavailable—or Linux selects the
`basic_text` backend—the app reports that state and refuses to persist or return credentials; there is no plaintext
fallback. Profiles remain usable because they contain only a display label and validated API endpoint.

`propr://connect` and `propr://open` are the only accepted deep-link actions. A single-instance lock routes later
activations to the existing window. Local lifecycle methods intentionally return `not-implemented`; this scaffold does
not download, install, start, or execute ProPR runtime components.

## Desktop distributables and releases

Desktop releases have their own `desktop-v<major>.<minor>.<patch>` tags. They do not use or require the monorepo's
`v<version>` tag. `PROPR_DESKTOP_VERSION` propagates the tag version into the packaged application, renderer, native
metadata, Linux packages, protected machine MSI, artifact names, and release manifest without changing the monorepo
package versions.

The native GitHub Actions matrix produces these assets for both x64 and arm64:

| Platform | Native runner | Direct-distribution artifacts |
| --- | --- | --- |
| Linux | `ubuntu-24.04`, `ubuntu-24.04-arm` | DEB, RPM, ZIP |
| macOS | `macos-15-intel`, `macos-15` | DMG, ZIP |
| Windows | `windows-2025`, `windows-11-arm` | signed per-machine Program Files MSI |

Every matrix job stages DEB/RPM/ZIP/DMG names as `ProPR-Desktop-<version>-<platform>-<arch>.<format>` and retains
`ProPR-Desktop-<version>-windows-<arch>-Machine-Setup.msi` for Windows. The final job rejects
missing targets or changed fragment checksums, emits `SHA256SUMS` and `desktop-release.json`, and attaches the complete
set to the matching GitHub release. Production publication is triggered only by a new, non-forced
`desktop-v<major>.<minor>.<patch>` tag push; there is no manual dispatch path. A secretless preflight must succeed before
any job can request the protected release environment or receive release secrets. Normal local packages are unsigned
and have updates disabled:

```sh
npm ci
npm run desktop:typecheck
npm run desktop:test
npm run desktop:package
xvfb-run --auto-servernum npm run desktop:smoke # Linux

# Full unsigned Linux release artifacts (requires dpkg-deb and rpmbuild/rpm):
PROPR_DESKTOP_VERSION=1.2.3 \
PROPR_DESKTOP_ENABLE_DEB=1 \
PROPR_DESKTOP_ENABLE_RPM=1 \
npm run make -w @propr/desktop -- --arch="$(node -p process.arch)"
```

### CI preflight, signing, and notarization configuration

Repository-ruleset inspection uses a dedicated GitHub App installed only on this repository. Configure the App with
exactly repository **Administration: read**, **Contents: read**, and **Environments: read** (GitHub adds Metadata: read
implicitly), with no write permission and no Actions, Deployments, Releases, or other repository permission. Store its
private key only in a separate approval-protected `desktop-release-preflight` environment:

- Variable `PROPR_DESKTOP_PREFLIGHT_APP_ID`: the least-privilege preflight App ID.
- Secret `PROPR_DESKTOP_PREFLIGHT_APP_PRIVATE_KEY`: that App's private key.

Configure `desktop-release-preflight` with at least one required reviewer, custom deployment policies enabled,
protected-branch policies disabled, and exactly one deployment policy: the tag pattern `desktop-v*`. The workflow
uses a SHA-pinned token action to mint a short-lived installation token explicitly requesting only Administration read,
Contents read, and Environments read; workflow regression tests pin those exact inputs and reject any write or Actions
permission. The App installation itself must have the same exact least-privilege permission set. Preflight fails closed
when the ruleset API does not return `bypass_actors`. Pull requests do not schedule this job, and a nonmatching or
unreviewed tag cannot enter the environment or obtain the App credential. The preflight environment must contain no
signing, notarization, update-signing, release-publication, or production deployment secret.

Signing material is read only from the distinct approval-protected `desktop-release` GitHub environment and written
to runner-temporary files/keychains. Every value below is mandatory for a production `desktop-v*` tag; unsigned and
partially signed production releases fail before publication. Pull-request package validation and the preflight
environment receive none of these secrets and explicitly check that release-secret environment variables are absent.

GitHub Actions secrets:

- `PROPR_DESKTOP_MAC_CERTIFICATE_P12_BASE64`: base64 of the Developer ID Application `.p12`.
- `PROPR_DESKTOP_MAC_CERTIFICATE_PASSWORD`: password for that `.p12`.
- `PROPR_DESKTOP_APPLE_API_KEY_P8_BASE64`: base64 of the App Store Connect API `.p8` key.
- `PROPR_DESKTOP_APPLE_API_KEY_ID`: App Store Connect API key ID.
- `PROPR_DESKTOP_APPLE_API_ISSUER_ID`: App Store Connect issuer UUID.
- `PROPR_DESKTOP_WINDOWS_CERTIFICATE_PFX_BASE64`: base64 of the Authenticode `.pfx`.
- `PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD`: password for that `.pfx`.
- `PROPR_DESKTOP_UPDATE_PRIVATE_KEY`: base64 Ed25519 PKCS#8 DER key used only to sign update-channel metadata.

GitHub Actions variables (public configuration, not secrets):

- `PROPR_DESKTOP_MAC_SIGNING_IDENTITY`: exact Developer ID Application identity.
- `PROPR_DESKTOP_MAC_TEAM_ID`: exact Team ID embedded in signed macOS update builds and verified from produced apps.
- `PROPR_DESKTOP_WINDOWS_SIGNING_IDENTITY`: exact Authenticode certificate subject expected by installed builds.
- `PROPR_DESKTOP_WINDOWS_SIGNER_PINS`: sorted, unique comma-separated allowlist of one or more
  `certificate-sha256:<64 lowercase hex>` or `spki-sha256:<64 lowercase hex>` fingerprints. Production Windows
  packaging fails closed when this public operator pin is absent, malformed, or does not match the signing key.
- `PROPR_DESKTOP_UPDATE_PUBLIC_KEY`: base64 Ed25519 SPKI DER public key matching the update private key.
- `PROPR_DESKTOP_UPDATE_MANIFEST_URL`: stable HTTPS URL from which clients fetch `desktop-release.json`; the detached
  signature must be published beside it as `desktop-release.json.sig`.
- `PROPR_DESKTOP_DARWIN_X64_FEED_URL`, `PROPR_DESKTOP_DARWIN_ARM64_FEED_URL`: macOS JSON feed URLs.

Generate the independent update-channel keys once and store only the public output as a repository variable:

```sh
openssl genpkey -algorithm ED25519 -outform DER -out desktop-update-private.der
openssl pkey -inform DER -in desktop-update-private.der -pubout -outform DER -out desktop-update-public.der
base64 < desktop-update-private.der # secret: PROPR_DESKTOP_UPDATE_PRIVATE_KEY
base64 < desktop-update-public.der  # variable: PROPR_DESKTOP_UPDATE_PUBLIC_KEY
```

Do not commit either key file. The private key is available only to the approval-protected `desktop-release`
environment. Configure that environment with at least one required reviewer, custom deployment policies enabled,
protected-branch policies disabled, and exactly one deployment policy: the tag pattern `desktop-v*`. The repository's
default branch must be protected `main`. It must also have an active tag-targeting ruleset whose sole include is
`refs/tags/desktop-v*`, whose exclude and bypass-actor lists are empty, and whose rules block both tag updates and tag
deletions.

For each new, non-forced `desktop-v<major>.<minor>.<patch>` tag push, the read-only preflight verifies both protected
environments and the repository prerequisites through the GitHub API, proves the exact tag commit is reachable from
`main`, rejects an existing release, and rechecks the tag and immutability ruleset for changes. The active tag ruleset
must match exactly `refs/tags/desktop-v*`, have no exclusions or bypass actors, and block update and deletion. Pull-
request finalization produces unsigned validation metadata; trusted signing jobs depend on preflight, check out its
immutable SHA, revalidate the tag before publication, and fail closed if any signing, notarization, or signed-update
field is missing. A release operator must publish the exact signed manifest/signature, generated macOS feeds, and
bound macOS packages to their configured HTTPS URLs. The manifest URL must not contain a query, so its companion is
always the documented pathname plus `.sig`.

Linux never checks for native updates. macOS remains a signed, check-only channel: it verifies the Ed25519 manifest,
exact target/version/feed bytes, package URL/size/SHA-256, and actual Team ID/designated requirement. Windows self-update
is explicitly `unsupported` for this release. The Windows build embeds no update URL or key even when update environment
variables are present; its public check and apply boundaries return `unsupported` before any network, cache, artifact,
signer, install-authority, or apply-capability call, and signed release metadata advertises no Windows feed.

Windows still publishes exactly one timestamped Authenticode-signed machine-wide MSI for each x64 and ARM64 target,
with the packaged application's signer and architecture inspected before staging. Per-user Squirrel Setup/NUPKG
artifacts remain unsupported and are never staged, checksummed, advertised, or published. Unsigned developer packages
remain update-disabled. Windows self-update installation work resumes only under issue #2000.
