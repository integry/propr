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

Desktop development, typecheck, package, and make commands build required renderer workspace dependencies through the
desktop workspace lifecycle, in dependency order (`@propr/shared`, `@propr/local-setup`, `@propr/cli`, then
`@propr/client`). They do not depend on previously generated workspace `dist` directories.

Development renderer URLs are accepted only when Electron Forge supplies an HTTP loopback URL. Packaged builds load
the generated renderer from the application ASAR through an app-owned protocol.

The packaged-binary smoke test verifies the hardened fuse states and launches artifacts without a sandbox-disabling
flag. Its preferred window is 1280x820 with an 880x620 minimum, sourced from one runtime/smoke sizing manifest. The
runtime selects the cursor-relevant display with a primary-display fallback and clamps both sizes to that display's
work area before native construction. Native evidence requires the actual window to equal that clamped size and
derives the viewport from the actual native content bounds. The packaged smoke also constructs a hidden 800x560
reduced-work-area window and verifies its real native bounds and clamped minimums. From the packaged custom-protocol
renderer it drives preload IPC, activation-scoped REST and Socket.IO upgrades through Electron session interception,
scope rotation, and same-ID origin editing. It also checks the real welcome-card and connection-control bounds, cookie
omission, both-origin storage cleanup, stale-scope fencing, renderer/main secret custody, uncaught exceptions, and a
clean exit. The child receives only fixed smoke triggers, private profile/temp paths, and strictly validated platform
launch inputs; it never broadly inherits the parent CI environment or `PATH`. `desktop:smoke:inspect` performs
executable and fuse inspection without launching a window. Release CI launches both Linux architectures under Xvfb,
inspects macOS and Windows packages on their native runners, validates DMG/ZIP/DEB/RPM/MSI packages, and validates
configured OS signatures.

Darwin packaged Connect acceptance first inspects the normal unsigned package, then generates a one-run self-signed
CA:false code-signing leaf in an isolated default keychain and signs only that smoke artifact. The signature uses an
explicit certificate-bound designated requirement that is verified before the pair process and again after the
reprobe process. Chromium creates and reopens its real Safe Storage key in the same disposable keychain; the harness
does not pre-seed or widen access to that item. A signal-aware exit trap restores the runner's original keychain list
and default, deletes the disposable keychain, and removes all temporary signing material.

The first-release Windows MVP packages only the normal desktop application. Native self-update installation authority
is deferred to issue #2000: no broker, bootstrap, launcher, service, or authority custom action is built, copied into
`resources`, or installed by the MSI. Both Windows architectures remain optional validation targets while Windows
publication is deferred, and package/MSI inspection fails if any deferred authority resource appears.

`desktop:audit` deliberately applies separate policies to the two dependency surfaces: low-or-higher advisories fail
the production-runtime audit, while high and critical advisories fail the desktop development/build-tool audit. Release
CI runs both checks directly from the committed lockfile before installing or executing the packaging toolchain.

## Security boundary

The renderer has no Node.js integration and receives only the typed `window.proprDesktop` bridge. It exposes metadata,
validated profiles, status-only pairing/probe/invalidation operations, lifecycle placeholders, and validated deep-link
events. Pairing, browser approval, credential persistence, authenticated probes, and revocation run in Electron main.
The bridge never exposes a credential value, shell, command runner, arbitrary IPC call, or filesystem path/API.

Profile metadata is stored in an app-owned, permission-restricted JSON file. Credential values are encrypted with
Electron `safeStorage` before they are written separately. If OS encryption is unavailable—or Linux selects the
`basic_text` backend—the app reports that state and refuses to persist credentials; there is no plaintext
fallback. Profiles remain usable because they contain only a display label and validated API endpoint.

Opaque instance tokens and the strict-discovery public identity are bound to profile ID, normalized origin, and
credential generation in encrypted main-process storage. The renderer cannot provide or override the identity.
Launch, profile switch, pairing, revocation, and every Socket.IO reconnect perform credential-free strict discovery;
an absent, malformed, or changed identity sends no stored bearer and requires a fresh pairing generation. Electron's
session request boundary strips renderer-supplied Authorization and Cookie headers from every HTTP(S) and WS(S)
request, including inactive or mismatched profile origins, then injects the active bearer only for matching REST and
Socket.IO requests. Set-Cookie is stripped from remote responses, so the packaged renderer has no parallel cookie
identity. Tokens never enter renderer JavaScript, URLs, logs, localStorage, sessionStorage, or profile metadata.
Switching named profiles clears renderer and instance-origin state. Removing or changing a paired profile first
attempts current-token revocation at the old bound origin, then removes the credential.

`propr://connect` and `propr://open` are the only accepted deep-link actions. A single-instance lock routes later
activations to the existing window. Local lifecycle methods intentionally return `not-implemented`; this scaffold does
not download, install, start, or execute ProPR runtime components.

## Desktop distributables and releases

Desktop releases have their own `desktop-v<major>.<minor>.<patch>` tags. They do not use or require the monorepo's
`v<version>` tag. `PROPR_DESKTOP_VERSION` propagates the tag version into the packaged application, renderer, native
metadata, Linux packages, the deferred protected machine MSI, artifact names, and release manifest without changing the monorepo
package versions.

The first production release uses the explicit, fail-closed `macos-linux-v1` profile. It produces exactly 10 native
artifacts for these four targets: `linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`.

| Platform | Native runner | Direct-distribution artifacts |
| --- | --- | --- |
| Linux | `ubuntu-24.04`, `ubuntu-24.04-arm` | DEB, RPM, ZIP |
| macOS | `macos-15-intel`, `macos-15` | DMG, ZIP |

Each Linux architecture contributes DEB, RPM, and ZIP (six artifacts); each macOS architecture contributes DMG and ZIP
(four artifacts). Every matrix job stages names as `ProPR-Desktop-<version>-<platform>-<arch>.<format>`. Finalization,
metadata signing, checksum aggregation, and publication all require the explicit profile and reject a missing,
duplicate, or unexpected fragment or artifact—including every Windows artifact. They emit `SHA256SUMS` and
`desktop-release.json` and attach the complete set to the matching GitHub release. Production publication is triggered
only by a new, non-forced
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

### Unsigned internal-RC install and removal (macOS/Linux)

Choose the artifact whose `x64` or `arm64` suffix matches the machine. These are internal validation builds: they do
not claim signing, notarization, or Gatekeeper approval, and the commands below do not weaken quarantine or trust
policy. An unsigned macOS build may therefore be rejected on a normal end-user machine.

Debian/Ubuntu DEB installation and native removal:

```sh
ARCH=x64 # use arm64 on an ARM64 Linux machine
VERSION=0.8.15
sudo apt install "./ProPR-Desktop-${VERSION}-linux-${ARCH}.deb"
propr-desktop
xdg-open 'propr://connect?api=http%3A%2F%2Flocalhost%3A4000'
xdg-open 'propr://connect?api=https%3A%2F%2Ft-your-tunnel.propr.dev'
sudo apt remove propr-desktop
```

Fedora/RHEL-family RPM installation, followed by the package-manager-independent ZIP flow:

```sh
ARCH=x64 # use arm64 on an ARM64 Linux machine
VERSION=0.8.15
sudo rpm --install "ProPR-Desktop-${VERSION}-linux-${ARCH}.rpm"
propr-desktop
sudo rpm --erase propr-desktop

install_root="$(mktemp -d)"
unzip "ProPR-Desktop-${VERSION}-linux-${ARCH}.zip" -d "$install_root"
"$install_root/propr-desktop-linux-${ARCH}/propr-desktop"
rm -r "$install_root"
```

On Intel (`x64`) or Apple Silicon (`arm64`) macOS, mount and copy the DMG or extract the ZIP. Quit the app before
removing it:

```sh
ARCH=arm64 # use x64 on an Intel Mac
VERSION=0.8.15
mount_point="$(mktemp -d)"
hdiutil attach -readonly -nobrowse -mountpoint "$mount_point" \
  "ProPR-Desktop-${VERSION}-macos-${ARCH}.dmg"
sudo ditto "$mount_point/propr-desktop.app" '/Applications/propr-desktop.app'
hdiutil detach "$mount_point"
rmdir "$mount_point"
open '/Applications/propr-desktop.app'
open 'propr://connect?api=http%3A%2F%2Flocalhost%3A4000'
open 'propr://connect?api=https%3A%2F%2Ft-your-tunnel.propr.dev'
osascript -e 'tell application id "dev.propr.desktop" to quit'
sudo rm -r '/Applications/propr-desktop.app'

install_root="$(mktemp -d)"
ditto -x -k "ProPR-Desktop-${VERSION}-macos-${ARCH}.zip" "$install_root"
open "$install_root/propr-desktop.app"
osascript -e 'tell application id "dev.propr.desktop" to quit'
rm -r "$install_root"
```

The pull-request native gate runs DEB/RPM/ZIP on `ubuntu-24.04` and `ubuntu-24.04-arm`, and DMG/ZIP on
`macos-15-intel` and `macos-15`. Every staged format is extracted or mounted and copied, launched, shut down,
relaunched with the same isolated profile, and removed. It verifies the staged hash remains unchanged, executable
architecture and native launcher registration, profile permissions and state preservation, warm OS protocol dispatch,
renderer exactly-once acknowledgement, explicit confirmation of untrusted Connect candidates, and cleanup of owned
processes, mounts, LaunchServices registration, profiles, and install roots.

For copied macOS test apps only, CI reuses the packaged-Connect harness to generate one disposable, non-production
code-signing identity in an isolated keychain. It signs the copied app (never the staged DMG/ZIP), verifies the same
designated requirement before and after both launches, and restores the runner's original keychain list/default before
deleting the identity and temporary keychain. This stabilizes the Safe Storage application identity without changing
trust settings and is not evidence of Developer ID signing, notarization, Gatekeeper approval, or end-user launchability.
Linux intentionally withholds the outer session bus from the artifact process: it proves plaintext/basic-text fallback
is refused, but does not claim libsecret custody. Cold launches are direct argv; Linux package warm dispatch uses an
isolated XDG MIME database and `gio`, ZIP warm dispatch is direct because ZIP has no registered launcher, and macOS
warm dispatch uses LaunchServices against the exact copied bundle.

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
to runner-temporary files/keychains. Every macOS/update value below is mandatory for a production `desktop-v*` tag;
Windows credentials are neither read nor required by `macos-linux-v1`. Unsigned and
partially signed production releases fail before publication. Pull-request package validation and the preflight
environment receive none of these secrets and explicitly check that release-secret environment variables are absent.

GitHub Actions secrets:

- `PROPR_DESKTOP_MAC_CERTIFICATE_P12_BASE64`: base64 of the Developer ID Application `.p12`.
- `PROPR_DESKTOP_MAC_CERTIFICATE_PASSWORD`: password for that `.p12`.
- `PROPR_DESKTOP_APPLE_API_KEY_P8_BASE64`: base64 of the App Store Connect API `.p8` key.
- `PROPR_DESKTOP_APPLE_API_KEY_ID`: App Store Connect API key ID.
- `PROPR_DESKTOP_APPLE_API_ISSUER_ID`: App Store Connect issuer UUID.
- `PROPR_DESKTOP_UPDATE_PRIVATE_KEY`: base64 Ed25519 PKCS#8 DER key used only to sign update-channel metadata.

GitHub Actions variables (public configuration, not secrets):

- `PROPR_DESKTOP_MAC_SIGNING_IDENTITY`: exact Developer ID Application identity.
- `PROPR_DESKTOP_MAC_TEAM_ID`: exact Team ID embedded in signed macOS update builds and verified from produced apps.
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
exact target/version/feed bytes, package URL/size/SHA-256, and actual Team ID/designated requirement.

### Deferred Windows publication

Windows publication is deferred to a separately gated follow-up release. The source, security assertions, unit tests,
native x64/ARM64 package jobs, machine-wide MSI checks, and ordinary-user runtime validation remain intact. Those two PR
matrix entries use the deliberate `macos-linux-windows-v1` compatibility profile, are non-blocking for
`macos-linux-v1`, and upload under an optional-Windows artifact namespace that canonical finalization never downloads.
The six-target profile retains its 12-artifact contract for future activation, including Windows certificate subject,
cryptographic pin, timestamp, installed-application, architecture, and signer-equality gates. It is not a production
workflow mode yet. Per-user Squirrel Setup/NUPKG artifacts remain unsupported.

Before a future Windows-inclusive mode can be enabled, operators must separately configure the Authenticode PFX and
password, exact signing identity, and sorted certificate/SPKI SHA-256 pin allowlist. None of those values belongs in or
can satisfy the first-release profile. For the current release, the external credentials that must be ready are the
Developer ID Application P12/password, App Store Connect notarization key/key ID/issuer ID, Ed25519 update signing key
pair, stable HTTPS manifest URL, and both architecture-specific macOS feed URLs listed above.
