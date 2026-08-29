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

The desktop typecheck and package commands build required renderer workspace dependencies through
`desktop:prepare`, so they do not depend on a previously generated `packages/shared/dist` directory.

Development renderer URLs are accepted only when Electron Forge supplies an HTTP loopback URL. Packaged builds load
the generated renderer from the application ASAR through an app-owned protocol.

The packaged-binary smoke test verifies the hardened fuse states, launches artifacts where the host permits, rejects
main-process uncaught exceptions, and requires proof that `window.proprDesktop` is exposed before accepting
renderer-ready and a clean exit. `desktop:smoke:inspect` performs executable and fuse inspection without launching a
window. Release CI launches both Linux architectures under Xvfb, inspects macOS and Windows packages on their native
runners, validates DMG/ZIP/DEB/RPM/NuGet containers, and validates configured OS signatures.

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
metadata, Linux packages, Squirrel package, artifact names, and release manifest without changing the monorepo
package versions.

The native GitHub Actions matrix produces these assets for both x64 and arm64:

| Platform | Native runner | Direct-distribution artifacts |
| --- | --- | --- |
| Linux | `ubuntu-24.04`, `ubuntu-24.04-arm` | DEB, RPM, ZIP |
| macOS | `macos-15-intel`, `macos-15` | DMG, ZIP |
| Windows | `windows-2025`, `windows-11-arm` | Squirrel Setup.exe, full NuGet update package, RELEASES metadata |

Every matrix job stages names in the form `ProPR-Desktop-<version>-<platform>-<arch>-<kind>`. The final job rejects
missing targets or changed fragment checksums, emits `SHA256SUMS` and `desktop-release.json`, and attaches the complete
set to the matching GitHub release. A workflow dispatch can test any stable semver without publishing; publishing a
dispatch requires an existing matching tag. Normal local packages are unsigned and have updates disabled:

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

### CI signing and notarization configuration

Signing material is read only from GitHub Actions secrets and written to runner-temporary files/keychains. Configure
all values in a group or none; partial groups fail the release.

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
- `PROPR_DESKTOP_WINDOWS_SIGNING_IDENTITY`: exact Authenticode certificate subject expected by installed builds.
- `PROPR_DESKTOP_UPDATE_PUBLIC_KEY`: base64 Ed25519 SPKI DER public key matching the update private key.
- `PROPR_DESKTOP_UPDATE_MANIFEST_URL`: stable HTTPS URL from which clients fetch `desktop-release.json`; the detached
  signature must be published beside it as `desktop-release.json.sig`.
- `PROPR_DESKTOP_DARWIN_X64_FEED_URL`, `PROPR_DESKTOP_DARWIN_ARM64_FEED_URL`: Squirrel.Mac JSON feed URLs.
- `PROPR_DESKTOP_WINDOWS_X64_FEED_URL`, `PROPR_DESKTOP_WINDOWS_ARM64_FEED_URL`: Squirrel.Windows feed directories.

Generate the independent update-channel keys once and store only the public output as a repository variable:

```sh
openssl genpkey -algorithm ED25519 -outform DER -out desktop-update-private.der
openssl pkey -inform DER -in desktop-update-private.der -pubout -outform DER -out desktop-update-public.der
base64 < desktop-update-private.der # secret: PROPR_DESKTOP_UPDATE_PRIVATE_KEY
base64 < desktop-update-public.der  # variable: PROPR_DESKTOP_UPDATE_PUBLIC_KEY
```

Do not commit either key file. The private key should be held separately for recovery and rotation. A release operator
must publish the exact signed manifest/signature and the referenced native feed files to the configured HTTPS
locations. Merely setting a feed URL cannot enable updates: the build also requires a complete update key pair,
platform signing credentials, and the explicit CI-only signed-build gate. At runtime, Linux never initializes Electron's
native updater; macOS and Windows verify the detached Ed25519 manifest, target architecture, and embedded signing
identity before giving a feed URL to `autoUpdater`. macOS additionally requires the native application signature, while
Windows releases are Authenticode-signed at both package and installer stages.
