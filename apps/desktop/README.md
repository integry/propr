# ProPR Desktop

This workspace packages the existing `propr-ui` React source as a sandboxed Electron renderer. The desktop entry is
`propr-ui/src/desktop.tsx`; the normal web entry, service worker, CLI, API, and self-hosted deployment remain unchanged.

## Supported platforms and first launch

The first desktop release supports `linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`. Linux artifacts are
DEB, RPM, and ZIP; macOS artifacts are DMG and ZIP. Windows source and security tests remain in the repository, but the
`macos-linux-v1` release contains no Windows artifact and Windows desktop GA is deferred.

Use **Set up this computer** on Linux to create an isolated desktop-managed local runtime. It requires a maintained
Docker Engine, a reachable daemon, permission for the current user to use its socket without interactive `sudo`, image
registry access, GitHub access, and enough disk/memory for the selected agents. The wizard checks the host, creates its
private stack root below the isolated desktop profile, pulls release-aligned images, opens interactive authentication in a visible
terminal when needed, starts the stack, checks health and the complete public desktop contract, and only then
saves/probes/pairs/activates the ordinary local profile. A legacy image that exposes only `/api/compatibility` fails with
the required contract and image named in the recovery action; it is never reported as successful setup.
Cancel waits for the active host or authentication child and rolls back completed mutations where supported. A cancelled,
failed, or interrupted run retains only the bounded resume choices needed for **Retry setup** or **Review saved choices**.

macOS is remote-only: local setup is not offered and the app makes zero host-stack mutations. Choose **Connect to an
existing instance** and enter an HTTPS endpoint (or explicit loopback HTTP endpoint), or review a ProPR Connect discovery
candidate. Manual, discovery, and `propr://connect` candidates are never paired or selected without confirmation. If the
instance returns 401, **Sign in in browser** opens its API-supplied approval page; after approval, return to the app to
finish pairing. If the default-browser handoff is not visible, use **Reopen browser** or **Copy approval link** while the
current approval is still pending. Use the **Connected: _name_** control to switch, edit, remove, or re-pair saved profiles. Profile metadata
survives relaunch; the credential remains in the OS secure store.

Linux and macOS expose one native ProPR tray/menu-bar item. Its **Active work** total is the sum of current running
queue Tasks and the signed-in account's generating/refining Plans. Standalone incomplete repository todos are shown
separately as **Open goals** and excluded from the active total because Goals have no authoritative executing state.
The tooltip and menu retain separate Tasks, Plans, unsupported Goals, and Open goals values; `Unavailable` means the
instance or active authenticated profile could not be verified and is intentionally distinct from a verified zero.
On Linux, left-clicking the tray icon restores and focuses ProPR; right-clicking opens the native actionable menu. On
macOS, menu-bar activation continues to open that menu. **Open ProPR** uses the same restoration path, while **Quit
ProPR** uses the normal coordinated shutdown. Closing a window keeps the existing platform behavior—it does not enable a
new hidden background mode. Windows tray support remains deferred.

Linux native task notifications pass the same transparent, full-color ProPR application artwork to Electron as an
absolute local icon path in both development and packaged execution. macOS notifications continue to use the app's
bundle identity and the operating system's native presentation instead of requesting a custom per-alert icon. Electron's
[macOS notification implementation](https://www.electronjs.org/docs/latest/api/notification) uses Apple's User
Notifications framework and requires a code-signed application; ineligible development builds report a native delivery
failure. A temporary/ad-hoc package is diagnostic evidence only: the absence of a banner can also be caused by macOS
notification settings, Focus, or presentation policy—[alert authorization does not guarantee on-screen
presentation](https://developer.apple.com/documentation/usernotifications/unnotificationsettings/alertsetting)—so
release delivery must be validated with the signed, installed artifact. Windows native notifications remain deferred.

### Recovery and troubleshooting

- If Linux does not show **Set up this computer**, confirm that the running artifact is a current Linux package. The
  control is intentionally absent on macOS and Windows.
- For Docker absent, daemon-down, socket-permission, disk, image-pull, setup, authentication, or health errors, follow the
  wizard's next action, correct the host condition, and use **Retry setup**. Do not run the desktop app with elevated
  privileges to work around socket permissions.
- Interactive GitHub or agent authentication requires one of `x-terminal-emulator`, GNOME Terminal, Konsole, or xterm.
  The desktop waits for the authentication command itself, including terminals backed by an existing server, and safe
  cancellation terminates that owned child before setup reports cancellation.
- On Linux, an unlocked Secret Service/libsecret backend is required. If Electron selects `basic_text` or secure storage
  is unavailable, pairing fails closed instead of saving a plaintext token.
- **Revoked or expired** means the instance rejected the saved token; pair again. **Offline** preserves the profile and
  can be retried after connectivity returns. An incompatible instance must be upgraded before connection.
- A ProPR Connect tunnel endpoint or public identity change is a new trust generation. Review the new origin and pair
  again; old REST cookies, bearer state, Socket.IO state, and renderer storage are not reused.
- Before uninstalling on macOS, choose **Quit ProPR** and wait for the app to exit; closing a window does not necessarily
  quit the app. Quit normally on Linux as well. Coordinated shutdown stops new IPC work, drains admitted
  pairing/setup/deep-link work, closes sockets, and releases the single-instance lock.

## Commands

Run these from the repository root:

```sh
npm run desktop:dev
npm run desktop:typecheck
npm run desktop:test
npm run test:native-durability -w @propr/desktop
npm run desktop:package
npm run desktop:smoke # Run under xvfb-run on a headless Linux host.
npm run desktop:acceptance # Linux x64 package; run under Xvfb in a D-Bus/keyring session.
npm run desktop:acceptance:install-linux -- <two-version DEB/RPM arguments> # Opt-in Docker acceptance.
npm run desktop:make
npm run desktop:audit
# Rebuild/check Linux PNG and macOS ICNS assets from the pinned ProPR PWA mark:
npm run icons:generate -w @propr/desktop
npm run icons:check -w @propr/desktop
# On Linux hosts with the corresponding native packaging tools installed:
npm run make:deb -w @propr/desktop
npm run make:rpm -w @propr/desktop
# macOS only, after packaging the selected architecture:
npm run make:dmg -w @propr/desktop -- --arch=arm64
```

The Linux transaction durability parity gate runs on both x64 and arm64 package jobs.
Its exact inventory is 141 tests: 87 credential-service (including active-work v3
goal-count coverage and the 11 credential regressions from #2299), 37 profile-store,
10 pairing-shutdown, and 7 pairing-browser.
`scripts/run-native-durability.mjs` requires exact suite and scenario counts, all 141
tests passing, zero failures/cancellations/skips, and a successful child-process exit.
When adding coverage to these suites, reconcile the runner inventory with an actual
native durability run; extra tests also fail until the inventory is updated. The
credential-service inventory is shared with the existing Windows runner; Windows job
scope and platform-specific scenario expectations are unchanged.

### Source-built Linux local runtime

The checked-in `0.8.15` launcher manifest describes the already-published general release and is deliberately not
rewritten to pretend that the desktop-epic backend has been published. To build the current committed epic source under
commit-scoped local tags, generate its explicit local-only manifest, smoke the discovery/auth capability surface in
owned ephemeral containers, and package the desktop against that manifest:

```sh
npm run desktop:runtime:build
revision="$(git rev-parse HEAD)"
npm run desktop:runtime:smoke -- "$revision" 2026-06-27
PROPR_DESKTOP_RUNTIME_MANIFEST="$PWD/.propr/desktop-runtime/$revision/manifest.json" npm run desktop:package
```

`desktop:runtime:build` requires a clean checkout and binds the build to its exact current commit. It builds only
`propr-desktop-local/app:<full-commit>` and `propr-desktop-local/ui:<full-commit>`, and marks them `local` in the generated
manifest. The wizard inspects those exact local images instead of attempting a registry pull. The smoke uses a unique
labelled network, Redis/API containers, random loopback port, and private temporary data root; its cleanup refuses any
container or network it does not own. It does not address or replace an existing ProPR stack.

If the compatibility gate finds an already-running legacy stack under Desktop's private managed root, ordinary Retry
continues to preserve it. The explicit **Restart with aligned runtime** recovery instead enumerates only containers with
that resolved stack's ownership label, removes those containers, and starts the manifest-selected images. Bind-mounted
data, credentials, logs, repositories, and the existing network remain in place; no default or personal CLI stack is
targeted.

### Opt-in packaged Linux setup cancellation acceptance

After packaging Linux x64, exercise cancellation and retry through the real packaged renderer, IPC bridge,
`DesktopSetupController`, and CLI host adapter with:

```sh
revision="$(git rev-parse HEAD)"
PROPR_DESKTOP_REAL_LINUX_SETUP_ACCEPTANCE=1 \
PROPR_DESKTOP_SETUP_ACCEPTANCE_SOURCE_SHA="$revision" \
npm run desktop:acceptance:setup-linux
```

The harness creates one owner-only temporary profile and runtime root, unique non-default stack/network names, and
three explicitly free loopback ports. Its Docker command boundary delegates the real CLI/daemon prerequisite and
image-presence inspections, then holds (without executing) the first mutating image pull so the packaged controller can
cancel an actually admitted child. It asserts settled visible recovery, child termination, a retry with a second real
host inspection and no overlapping execution, and interrupted recovery after a process-tree termination/relaunch. It
then verifies that no labelled container or unique network exists, that the host's container/network identities are
unchanged, and removes the private root. No credential variables are inherited and the run stops before GitHub
authentication or enrollment. The JSON report names the exact source SHA, command, package digest, verified phases,
cleanup result, and the intentionally unverified provisioning phases. If Docker or its daemon is unavailable, the
report is explicitly `unverified` at that phase and does not claim the lifecycle ran.

Run the focused non-Docker regressions with:

```sh
npm run build -w @propr/shared
npm run build -w @propr/local-setup
npm run build -w @propr/cli
npx tsx --test packages/cli/src/desktopLocalSetup.test.ts packages/cli/src/commands/setup/engine.test.ts
node --test apps/desktop/scripts/desktop-runtime-manifest.test.mjs
npm run desktop:typecheck
```

Production desktop jobs do not accept local tags or the ordinary launcher manifest. The protected release environment
must provide `PROPR_DESKTOP_RUNTIME_APP_IMAGE` and `PROPR_DESKTOP_RUNTIME_UI_IMAGE` as existing Docker Hub references in
the form `propr/<image>:<40-character-release-commit>@sha256:<digest>`. Linux release runners verify both references in
Docker Hub; every platform then generates and packages the same revision-, digest-, and compatibility-bound manifest.
Publish the epic app/UI images from the exact desktop release commit before creating `desktop-v*`; image publication
requires Docker Hub release authority and is intentionally outside the desktop workflow.

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
executable and fuse inspection without launching a window. Release CI launches both Linux architectures under Xvfb and
inspects both macOS architectures on native runners, validating DEB/RPM/ZIP/DMG packages and configured macOS signatures.
Separate non-blocking compatibility jobs retain Windows source and native-runtime checks without adding Windows artifacts
to the first-release profile.

## Packaged visual and accessibility acceptance

Linux x64 is the canonical visual runtime. `desktop:acceptance` launches the real packaged executable with a fresh
private Electron profile and drives it over Chromium's debugging protocol with Playwright. A separately authorized
acceptance mode supplies deterministic local API, Socket.IO, browser-pairing, ProPR Connect, and local-setup fixtures
while preserving the production main/preload/renderer boundary, renderer sandbox, context isolation, navigation
policy, and credential service. It requires independent command-line and environment triggers, accepts only a
packaged Linux binary, and refuses the default Electron profile.

The mandatory artifact contains screenshots for first run, endpoint and Connect confirmation, pairing, local setup
prerequisites/progress/recovery/completion, dashboard profile management, offline, revoked, and incompatible states.
Every state is captured at standard, narrow, high-DPI, 200% zoom, and reduced-motion configurations. The manifest
records fixed locale/time/theme inputs, dimensions, hashes, and native coverage. The 200% variant uses an
acceptance-only, main-authorized preload bridge to Electron `webFrame` zoom and records its read-back alongside raw
CDP/renderer viewports, independently measured geometry, DPR, and physical PNG dimensions. Accessibility evidence
fails for any serious or critical axe finding or missing keyboard order, visible focus, dialog trap/restore,
accessible name, or live announcement proof. Finalization rejects missing, duplicate, unexpected, incorrectly sized,
or secret-bearing output. Sentinel coverage includes renderer DOM, process output, URLs, local/session storage,
persisted profile/config data, screenshots and metadata, and every decompressed Playwright trace entry. Browser-generated
401 diagnostics from the intentional revoked-token request are classified only when they match the exact revoked fixture
origin and current-user request. Every other renderer console error or page error fails acceptance; the published report
retains only bounded category counts while the complete raw surface remains subject to secret scanning.

Linux x64 produces the canonical visual/accessibility runtime evidence. Linux arm64 and macOS x64/arm64 retain native
package inspection and platform runtime smoke coverage; their acceptance classification is structural/runtime-only.
Supplementary non-blocking Windows source/runtime validation is isolated from `macos-linux-v1` and is not release evidence.

Darwin packaged Connect acceptance first inspects the normal unsigned package, then generates a one-run self-signed
CA:false code-signing leaf in an isolated default keychain and signs only that smoke artifact. The signature uses an
explicit certificate-bound designated requirement that is verified before the pair process and again after the
reprobe process. Chromium creates and reopens its real Safe Storage key in the same disposable keychain; the harness
does not pre-seed or widen access to that item. A signal-aware exit trap restores the runner's original keychain list
and default, deletes the disposable keychain, and removes all temporary signing material.

Windows source and native validation continue as non-blocking compatibility work. Native self-update installation authority
is deferred: no broker, bootstrap, launcher, service, or authority custom action is built into the ordinary application.
No Windows package is staged, checksummed, advertised, or published by the first-release profile.

`desktop:audit` deliberately applies separate policies to the two dependency surfaces: low-or-higher advisories fail
the production-runtime audit, while high and critical advisories fail the desktop development/build-tool audit. Release
CI runs both checks directly from the committed lockfile before installing or executing the packaging toolchain.

## Security boundary

The renderer has no Node.js integration and receives only the typed `window.proprDesktop` bridge. It exposes metadata,
validated profiles, status-only pairing/probe/invalidation operations, Linux setup status/actions, and validated deep-link
events. Pairing, browser approval, credential persistence, authenticated probes, revocation, and every mutating Linux
setup action run in Electron main. macOS never constructs a mutating setup host.
The bridge never exposes a credential value, shell, command runner, arbitrary IPC call, or filesystem path/API.

Profile metadata is stored in an app-owned, permission-restricted JSON file. Credential values are encrypted with
Electron `safeStorage` before they are written separately. If OS encryption is unavailable—or Linux selects the
`basic_text` backend—the app reports that state and refuses to persist credentials; there is no plaintext
fallback. Profiles remain usable because they contain only a display label and validated API endpoint.

On macOS, keep `package.json`'s `productName` and Electron's internal app name as **ProPR Desktop**.
Electron initializes the Safe Storage Keychain namespace from the app name before `ready`, independently of
`userData`. Branding must never call `app.setName('ProPR')`, even if it restores all data paths. Visible ProPR
names come from explicit application menu labels, About options and localized bundle metadata.

The native branding continuity regression uses real Electron `safeStorage` in four fresh processes: legacy
encrypt, deliberately renamed negative control, branded decrypt/encrypt, then legacy decrypt. It reuses one
temporary profile and prefixes both native app names with a random UUID, so neither real ProPR Keychain
namespace is accessed. It deletes only its own synthetic Keychain items and temporary files, leaves Keychain
defaults/search lists/ACLs alone, and emits status only. Run in an unlocked macOS test session:

```sh
PROPR_DESKTOP_MAC_SAFE_STORAGE_TEST=1 node --test apps/desktop/scripts/macos-branding-safe-storage.test.mjs
```

The normal test suite skips this native test unless explicitly enabled; Linux crypto is not evidence of macOS
Keychain continuity. Existing-user signed-build verification remains a separate, unlock-dependent check.

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
activations to the existing window. The Linux setup controller binds the shared setup engine to an app-owned root and
capability-scoped file/secret selections; renderer code cannot choose arbitrary filesystem or command targets.

## Desktop distributables and releases

Desktop releases have their own `desktop-v<major>.<minor>.<patch>` tags. They do not use or require the monorepo's
`v<version>` tag. `PROPR_DESKTOP_VERSION` propagates the tag version into the packaged application, renderer, native
metadata, Linux packages, the deferred protected machine MSI, artifact names, and release manifest without changing the monorepo
package versions.

### Independent Linux preview channel

The recommended first Linux delivery is the manual **Desktop Linux Preview Release** GitHub Actions workflow and GitHub
Releases. It is independent of the tag-driven production workflow: it runs only on manual dispatch from `main`, uses
native `ubuntu-24.04` x64 and ARM64 runners, reads no Apple, Windows, update-signing, or publication secret, and emits
exactly these unsigned packages:

- `ProPR-Desktop-<version>-linux-x64.deb`
- `ProPR-Desktop-<version>-linux-x64.rpm`
- `ProPR-Desktop-<version>-linux-arm64.deb`
- `ProPR-Desktop-<version>-linux-arm64.rpm`

The bundle also contains `linux-preview.json`, `INSTALL.md`, and `SHA256SUMS`. The preview manifest records the full
source commit, desktop package version, architecture and format of every asset, digest-pinned runtime app/UI image
references, workflow run, `unsigned-preview` trust state, and manual package-manager upgrade policy. The generated
preview identity is `desktop-linux-preview-v<version>-<first-12-source-SHA>`; draft creation refuses an existing tag or
different asset at that identity. Finalization re-inspects both package architectures and accepts no ZIP, macOS,
Windows, stable update manifest, signature, or extra file.

Before staging, publish the source revision's multi-architecture runtime images for `linux/amd64` and `linux/arm64` and
obtain their immutable references:

```text
propr/app:<40-character-source-SHA>@sha256:<64-character-manifest-digest>
propr/ui:<40-character-source-SHA>@sha256:<64-character-manifest-digest>
```

The workflow verifies both registry manifests and embeds an API-compatible runtime manifest bound to the same source
revision. Missing images, a mutable tag-only reference, a digest mismatch, or a missing architecture is an actionable
preflight failure; the build never falls back to the checked-in launcher manifest. Stage the private draft with:

```sh
SOURCE_SHA=<full-lowercase-commit-on-main>
gh workflow run desktop-linux-preview.yml --ref main \
  -f operation=stage-draft \
  -f source_revision="$SOURCE_SHA" \
  -f runtime_app_image="propr/app:$SOURCE_SHA@sha256:<app-manifest-digest>" \
  -f runtime_ui_image="propr/ui:$SOURCE_SHA@sha256:<ui-manifest-digest>"
```

`stage-draft` has repository `contents: write` only in its final draft-staging job. It creates or safely resumes a
private GitHub draft, uploads the exact checksum allowlist, downloads every uploaded byte to verify it, and never
publishes or creates the preview tag. Pull requests, ordinary pushes, and the production `desktop-v*` tag workflow do
not invoke this channel.

Public preview publication is a second manual dispatch over the already-staged bytes. First create the
`desktop-linux-preview-publication` GitHub environment with required reviewers, restrict deployment to `main`, configure
a tag ruleset for `refs/tags/desktop-linux-preview-v*` that blocks updates and deletion, and set environment variable
`PROPR_DESKTOP_LINUX_PREVIEW_PUBLICATION_AUTHORIZED=1`. Do not store production signing credentials in this environment.
Then an authorized reviewer may run:

```sh
gh workflow run desktop-linux-preview.yml --ref main \
  -f operation=publish-draft \
  -f source_revision="$SOURCE_SHA"
```

Publication downloads and hashes the draft again, validates its exact four-package matrix and both native
architectures, checks the source-bound manifest and canonical instructions, then publishes it as a GitHub prerelease
with `make_latest=false`. It refuses an existing tag rather than moving or reusing one. GitHub Actions must be allowed
to create releases with the job-scoped `GITHUB_TOKEN`, both native hosted runner labels must be available, and the two
published runtime images plus the protected environment/tag ruleset are the complete external setup for this preview
channel. Apple Developer credentials, notarization, Ed25519 update keys, macOS runners, and Windows runners are not
requirements.

Preview DEB/RPM assets do not configure an apt or dnf repository and do not enable Linux self-updates. Users manually
download a newer architecture-matching asset and run `apt install ./<new>.deb` or `dnf upgrade ./<new>.rpm`; `INSTALL.md`
also documents `apt install --reinstall` / `dnf reinstall` when a newer source preview intentionally retains the same
package version. It travels with every release and includes install, launch, checksum, upgrade, and removal commands. The later production
Linux channel should use signed apt and dnf repositories, but it still needs independent package-signing keys, protected
offline/CI signing custody, repository metadata signing, HTTPS hosting/CDN, retention, rotation/revocation, and client
repository bootstrap instructions. None of that is simulated by this unsigned preview.

Snap and Flatpak are not first-delivery substitutes here. ProPR's Linux setup needs the host Docker daemon/socket and
terminal/browser handoffs; profiles need a real Secret Service/keyring; Connect/deep links need browser and URI-scheme
integration; and tray behavior spans StatusNotifier/XEmbed desktop environments. Snap interfaces or Flatpak portals and
socket/filesystem permissions would need a threat-model review plus installed-package testing on supported desktops.
Unvalidated classic confinement, broad filesystem/socket access, or portal fallbacks would weaken the current boundary,
so neither format blocks DEB/RPM delivery and neither is emitted by the preview workflow.

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

Linux runs each artifact against one isolated, unlocked D-Bus/libsecret session and proves credential round-trip and
deletion without permitting plaintext/basic-text fallback. Cold launches are direct argv; Linux package warm dispatch uses an
isolated XDG MIME database and `gio`, ZIP warm dispatch is direct because ZIP has no registered launcher, and macOS
warm dispatch uses LaunchServices against the exact copied bundle.

### Installed Linux package acceptance

The native gate above intentionally proves an **extracted artifact** lifecycle. It does not prove that a package manager
can resolve the package's declared dependencies, install it, upgrade it, or remove its owned system entries. Run the
separate installed-package acceptance with two unsigned internal-RC builds whose versions are strictly increasing:

```sh
ARCH=x64
PREVIOUS_VERSION=1.2.2
VERSION=1.2.3
ARTIFACTS="$PWD/desktop-package-acceptance"

PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE=1 \
npm run desktop:acceptance:install-linux -- \
  --arch "$ARCH" \
  --sandbox-isolation docker-cap-sys-admin \
  --previous-version "$PREVIOUS_VERSION" \
  --version "$VERSION" \
  --previous-deb "$ARTIFACTS/ProPR-Desktop-$PREVIOUS_VERSION-linux-$ARCH.deb" \
  --deb "$ARTIFACTS/ProPR-Desktop-$VERSION-linux-$ARCH.deb" \
  --previous-rpm "$ARTIFACTS/ProPR-Desktop-$PREVIOUS_VERSION-linux-$ARCH.rpm" \
  --rpm "$ARTIFACTS/ProPR-Desktop-$VERSION-linux-$ARCH.rpm"
```

Build both inputs from the source revision being accepted by setting `PROPR_DESKTOP_VERSION` to each version; do not
rename one package or use a same-version reinstall as upgrade evidence. The harness accepts only canonical non-link
artifact paths and runs Debian 12 and Rocky Linux 9 in separate auto-removed Docker containers. Those distributions are
representatives of the documented Debian/Ubuntu and Fedora/RHEL package families; they are not claims about every
derivative. Each container starts with no ProPR package or account, installs build-independent test prerequisites, then
uses `apt` or `dnf` for the package operations themselves.

The sandbox isolation mode is deliberately required. `docker-default` adds no capability and runs a mount/PID/network
namespace-creation preflight; Docker's usual capability boundary is expected to reject that preflight on many hosts.
`docker-cap-sys-admin` retains Docker's default `AUDIT_WRITE`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `KILL`,
`MKNOD`, `NET_BIND_SERVICE`, `NET_RAW`, `SETFCAP`, `SETGID`, `SETPCAP`, `SETUID`, and `SYS_CHROOT` capabilities and adds
exactly `SYS_ADMIN` and `IPC_LOCK` for each auto-removed acceptance container. `SYS_ADMIN` permits the Electron sandbox's
namespace creation. `IPC_LOCK` permits execution of Rocky Linux 9's real `/usr/bin/gnome-keyring-daemon`, whose distro
file capabilities include `cap_ipc_lock=ep`; Docker's default capability bounding set otherwise rejects that exec. The
mode does not use a privileged container, replace Docker's default seccomp profile, share host namespaces, or make any
bind mount writable. Docker documents `--cap-add` as the fine-grained alternative to `--privileged` and adjusts its
default seccomp profile for explicitly selected capabilities. Because `SYS_ADMIN` is still powerful inside the container,
use this mode only on an authorized isolated host or disposable VM:
https://docs.docker.com/engine/containers/run/#runtime-privilege-and-linux-capabilities

The preflight runs after installing only the distribution test prerequisites and before inspecting or installing either
ProPR package. It verifies that one process can create mount, PID, and network namespaces and run `/bin/true` in them.
It passes `--propagation unchanged` so util-linux does not also attempt an unrelated recursive change to the root mount's
propagation; the preflight does not verify such a propagation change or replace the later real sandboxed Electron launch.
After the previous package's payload is installed and verified, a separate 30-second preflight starts the real distro
keyring daemon as the synthetic user, unlocks only the disposable keyring, and pings `org.freedesktop.secrets` over its
disposable D-Bus session. An execution denial or readiness timeout is reported as an environment-limited
`keyring-preflight` before an application launch is attempted, with emitted diagnostic output capped at 4096 bytes.
If the host runtime still denies namespace creation, the harness reports `environment-limited`, names the last completed
and failed phases, records zero attempted/passed application launches, and makes no upgrade or uninstall claim. If a real
application launch later encounters the same namespace/zygote boundary, the failure record preserves the completed
metadata/payload checks and separate attempted/passed launch counts; it is never converted to a skipped or successful
launch. Use a disposable native Debian 12 or Rocky Linux 9 VM when host policy rejects the scoped capability. Do not
disable Electron's sandbox, use an unconfined seccomp profile, run a privileged container, or weaken host policy.

The check compares generated and installed name/version/architecture/dependency metadata, verifies executable,
setuid-sandbox, and native-addon ownership/modes and ELF architecture, verifies the desktop entry and `propr://` MIME
handler, and matches all three installed application/tray icons to the already pixel- and transparency-verified assets.
It launches the actually installed application as a synthetic unprivileged account under Xvfb both before and after the
upgrade without `--no-sandbox`. Each launch uses an unlocked, synthetic Secret Service keyring rooted inside that
account's disposable home and explicitly selects `gnome-libsecret`; it never reads a real keyring or permits plaintext
credential fallback. It then proves that the upgrade preserves synthetic app configuration, that uninstall preserves
the synthetic account's configuration and smoke data, and that the package database, launcher, application tree,
desktop entry, and system icon are removed. Package artifacts are mounted read-only; host profiles, keyrings, workers,
the host package database, and any host ProPR installation are never mounted or addressed.

Run `--arch x64` only on an x64 Linux Docker host. `arm64` remains a first-class builder/native-gate target and the same
installed-package harness accepts `--arch arm64`, but only on a native ARM64 Linux Docker host. The runner rejects a host
architecture mismatch, so QEMU/cross-architecture container success is never reported as native installed-package
validation. A successful x64 run therefore establishes concrete x64 acceptance and retains, but does not overstate,
ARM64 coverage.

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
