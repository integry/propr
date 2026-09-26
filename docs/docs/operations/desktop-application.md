---
title: Desktop application
---

# Desktop application

ProPR Desktop runs the existing Web UI inside a sandboxed Electron application and connects it to one or more ProPR
instances. The first release supports Linux and macOS. It does not change browser Web UI, CLI, API, or self-hosted behavior.

## Saved GitHub accounts

Desktop supports multiple saved GitHub accounts, including two accounts at the same instance URL.
Open the instance manager or chooser and select **Add account** beside that instance. Approve in the
browser, then confirm the actual **@username** in the native desktop dialog. If the browser selected
the wrong identity, cancel and open the approval link in a separate browser profile signed in to the
intended GitHub account. ProPR does not collect GitHub passwords or sign the browser out of GitHub.
The account name and public avatar appear beside the instance after confirmation.

A saved connection has an opaque binding ID, instance endpoint, and a separate GitHub account ID.
The binding ID is deliberately different for each account, even at the same endpoint. GitHub IDs,
not editable labels or usernames, identify accounts; roles and permissions are checked by the server.
Reauthorizing a saved binding cannot replace it with another browser identity. Removing a binding
revokes only its credential; an expired credential retains its account identity for reauthorization.
Existing connections keep their credentials and receive saved identity labels on their next browser
approval. No credential reset or server deployment is required.

There is one active account in the existing desktop window. Switching unmounts the connected app,
invalidates REST work, disconnects the scoped socket, and clears the persisted active selection
before probing the next binding. A failed switch or reload during switching leaves the chooser or
connection error instead of restoring the previous account. Activation clears renderer storage and
publishes a new transport generation; late responses and body reads are rejected. Native work counts,
notifications, pending pairing, and revocation continue to use the binding and transport generation.
Bearer tokens remain in main-owned OS-encrypted storage and never enter account display props.
Switching does not cancel server jobs already committed under the previous user's authorization.

### Follow-up: independent desktop windows

[Issue #2269](https://github.com/integry/propr/issues/2269) delivers switching in the existing window.
Independent accounts in separate windows remain deferred. That expansion needs a credential service,
active selection, renderer session/partition, IPC ownership, and navigation/notification routing per
window. Validate simultaneous same-origin sockets, window close/reload, and delayed notification
clicks before exposing a new-window account action. The current process-wide active binding cannot
provide that behavior.

### Follow-up: browser account switching

Browser switching remains deferred under [#2269](https://github.com/integry/propr/issues/2269).
The browser still uses its existing server session and CSRF protections. The shared account display
on the browser approval page is informational; it does not change authorization. A browser account
picker needs server-managed, independently revocable session namespaces plus account-scoped CSRF,
Socket.IO authentication, caches, and background/push work. This requires a coordinated server/client
rollout. Until then, use separate browser profiles for independent web logins.

### Validation and logout integration

Scoped logout from PR #2270, exact source head
`3d0dba0ab95ee2ee075a77b0a6fa828dd674ad1b`, is combined with account switching in
this follow-up. The API client has one cancellation controller and one response/body guard.
Both endpoint changes and account changes invalidate pending requests, buffered body reads,
clones, and stale error handling. Desktop requests without an active scope are rejected.
Logout retires only the active binding's credential and clears its active selection in the same
local transaction. Offline revocation remains in the encrypted retry journal; other saved
credentials and GitHub identities survive. A failed local logout remains visibly retryable.

The combined HTTP/Socket.IO regression pairs Alice and Bob on one loopback endpoint, activates
Alice, holds REST headers and streaming bodies, switches to Bob, rejects late Alice results,
checks Bob's live socket and REST identity, logs Bob out offline, reopens storage, verifies that
Alice still works, and rejects reauthorizing Bob as Alice. It also rejects a stale Alice logout
while Bob is active. The native version runs production preload/IPC handlers, Electron session
request hooks, credential service, API client, logout, and SocketProvider across actual processes.
It uses synthetic browser approval and storage encryption in a private temporary directory;
it does not test GitHub OAuth, the native confirmation dialog, or an OS keychain.

Commands run for this follow-up (from the repository root):

```sh
npm --workspace propr-ui test -- src/desktop/account-switching.integration.test.tsx src/api/apiClient.accounts.test.ts src/api/proprApi.logout.test.ts src/api/demoMode.test.ts src/desktop/DesktopExperience.transport.test.tsx src/contexts/SocketProvider.test.tsx
npx tsx --test apps/desktop/src/credential-service.test.ts apps/desktop/src/profile-store.test.ts apps/desktop/src/profile-store.crash-recovery.test.ts apps/desktop/src/saved-accounts.test.ts apps/desktop/src/ipc-lifecycle.test.ts apps/desktop/src/preload-bridge.test.ts
DISPLAY=:93 node apps/desktop/scripts/smoke-two-accounts.mjs
npx tsx --test test/agentVersionManagement.test.ts test/goalExecutionMode.test.ts
npm run desktop:typecheck
npm run desktop:package
npm run desktop:smoke:inspect
DISPLAY=:93 XAUTHORITY=/tmp/propr-xvfb/Xauthority dbus-run-session -- npm run desktop:smoke
DISPLAY=:93 node --test apps/desktop/scripts/linux-window-frame.test.mjs
```

The focused suites passed: 60 UI tests (plus the two UI Docker-context checks), 152 main-process
and storage tests, 26 tests in the two imported Node test files, the native two-account regression,
and desktop/UI typechecks. Linux x64 packaging and packaged executable/fuse inspection succeeded.
The native harness ran with Chromium's sandbox disabled on an isolated Xvfb display; this is test evidence, not a production sandbox verification. The packaged smoke
failed at launch because the container cannot provide a correctly owned/configured SUID sandbox
helper. Therefore packaged two-account acceptance has **not** passed. Native pointer/frame tests
skipped because an isolated window manager and xdotool were unavailable; frame and transparent
wordmark implementation/assets were not changed. The display number and Xauthority path above
are temporary runner values; use your own isolated desktop session when rerunning.

The execution environment also blocked `git merge --no-commit --no-ff` before it could write
`ORIG_HEAD.lock`: the linked worktree's Git metadata is root-owned. Three-way file integration
and semantic conflict resolution were prepared and tested, but a merge parent was **not**
recorded. The committing owner must finish a true merge of the exact logout head into the
account-switching branch, retaining these resolutions; do not merge the desktop epic into main.

Before release, repeat this journey with two real GitHub identities on Linux and macOS, using
different browser profiles on the same endpoint. Verify native identity confirmation and wrong-user
rejection, OS-encrypted persistence, offline logout followed by restart, eventual revocation of
only the logged-out token, switching back to the other account, tray counts, and delayed
notification clicks. Also verify the shipped frame and transparent wordmark in active/inactive
windows. No remote deployment or user credential reset was performed. Browser account switching
and independent desktop windows remain the explicit follow-ups described above.

## Platform and runtime matrix

| Desktop target | Packages | Existing instance | Guided local setup |
| --- | --- | --- | --- |
| Linux x64 | DEB, RPM, ZIP | Yes | Yes, when Docker and the published runtime images pass the host checks |
| Linux arm64 | DEB, RPM, ZIP | Yes | Yes, when Docker and the published runtime images pass the host checks |
| macOS Intel | DMG, ZIP | Yes | No; remote/loopback connection only |
| macOS Apple Silicon | DMG, ZIP | Yes | No; remote/loopback connection only |
| Windows | None in the first release | Deferred | Deferred |

Choose the package matching the operating system and CPU. Internal release-candidate packages can be unsigned. A public
macOS release is ready only after Developer ID signing, notarization, stapling, and signed update-feed verification in the
protected release jobs; an unsigned internal build is not evidence of those gates.

For Apple Silicon local-test packages, “unsigned” means no Developer ID certificate or notarization. Forge seals the
finished ARM64 bundle with an ad-hoc signature after plist, icon, fuse, and ASAR-integrity changes, before making ZIP/DMG
artifacts. The hash-pinned native authority prebuilds retain their existing linker signatures and are verified separately;
helpers, frameworks, and the final bundle are signed and strictly verified. Packaging fails if verification fails.
This fix is limited to unsigned macOS ARM64 builds; Intel, Windows, and certificate-signed release paths are unchanged.

CI verifies the copied DMG staging app and the extracted ARM64 ZIP/DMG payloads before applying its separate acceptance
test certificate. A native regression also checks rejection of changed plist, resource, helper, and native binary bytes.
To inspect an untouched local-test app on a Mac, run
`node apps/desktop/scripts/sign-darwin-local-package.mjs /path/to/propr-desktop.app`.
These checks do not launch the app or access Keychain. The owner still verifies GUI startup and normal secure storage on
the real Mac with isolated userData; ad-hoc validation does not establish Developer ID trust or notarization, and does not
change Gatekeeper, Keychain, or safeStorage policy.

## First launch and connection

On Linux, choose **Set up this computer** to install a desktop-managed local stack, or **Connect to an existing instance**
to use a stack that is already running. On macOS, use the existing-instance path. Enter an HTTPS API origin for remote
instances; cleartext HTTP is accepted only for explicit loopback development origins.

The app validates compatibility and the instance's public identity before authentication. If authentication is required,
select **Sign in in browser**, complete the instance-supplied browser approval, and return to the app. The approval URL
comes from the validated API response; the renderer cannot replace it. A ProPR Connect discovery result or
`propr://connect` link opens a confirmation screen and never pairs, switches profiles, or sends credentials automatically.
While Linux or macOS is waiting, **Reopen browser** retries the same approval in the default browser and **Copy approval
link** copies it for a manual handoff. Both actions expire with the current pairing and never start a replacement request.

ProPR sends external links through Electron's `shell.openExternal`, which opens the operating system's current-user
default browser. To use Chromium, set it as that user's default HTTP and HTTPS handler in the operating-system settings.
ProPR has no app-specific browser selection and does not change the system browser automatically.

After connection, use **Connected: _instance name_** to open the profile manager. You can add, switch, edit, remove, retry,
or re-pair profiles. Non-secret profile metadata survives relaunch. Offline profiles remain available for retry. A revoked
or expired profile requires browser pairing again. If a managed tunnel origin or public identity changes, treat it as a
new trust generation and confirm and pair again.

## macOS branding and application navigation (#2306)

The visible application name is **ProPR**. The package productName remains `ProPR Desktop` to preserve Electron's
existing storage defaults; startup retains the resolved userData, sessionData and logs paths before setting the runtime
and About name. Forge's `name`, `executableName`, output directories, `propr-desktop.app`, `Contents/MacOS/propr-desktop`,
`dev.propr.desktop`, helper identities, and `propr://` registration remain unchanged.

Finder compares the unlocalized display name against the bundle's on-disk name before using its localized name
([Apple documentation](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html#//apple_ref/doc/uid/TP40009249-SW9)).
Therefore the unlocalized `CFBundleName`/`CFBundleDisplayName` stay `propr-desktop`, while
`Resources/en.lproj/InfoPlist.strings`, Base and each existing app localization supply **ProPR** for both keys.
The development language is English. This avoids renaming the bundle or executable. The packager's
`afterCopyExtraResources` hook writes this metadata after plist generation and before integrity processing, signing,
and notarization. The final signing hook from #2303 still runs last; nothing here edits its signed result.

| Menu | Actions and shortcuts |
| --- | --- |
| ProPR | About ProPR, Settings… (`Cmd+,`), Services, Hide, Quit ProPR |
| File | New Plan (`Cmd+N`), Switch / Manage Instances… (`Cmd+Shift+I`), Close Window |
| Go | Back (`Cmd+[`), Forward (`Cmd+]`), Dashboard (`Cmd+1`), Inbox (`Cmd+2`), Plans (`Cmd+3`), Goals (`Cmd+4`), Tasks (`Cmd+5`), Repositories (`Cmd+6`), LLM Log (`Cmd+7`) |
| Edit / View / Window | Native editing, zoom/fullscreen, minimize, zoom window, bring all to front |

Settings opens the actual Settings page. Section navigation closes the instance manager. History includes ordinary
in-app links, filters and detail routes and is reset for every authenticated transport scope, including switching accounts
on the same instance. It does not traverse the document's history from a previous account. Native commands retain the
unsaved Plan Studio confirmation. Authenticated destinations disable while disconnected; instance management disables
while setup, connection or authentication is busy. Permission-restricted administration pages remain in the app UI.
Linux window framing and Windows' deferred application menus are unchanged.

**Root real-Mac verification required before closing #2306:** build the final artifact using the existing desktop build
and #2303 signing procedure; do not patch an already signed app. On an actual Mac:

1. Launch with the existing saved profiles. Check the menu-bar app name, About title, Dock tooltip, Finder display name,
   and native window title. All should show ProPR; verify the stored profiles and accounts survived. Repeat under a
   non-English system language to exercise localization fallback. The shell pathname remains `propr-desktop.app`.
2. Inspect the raw plist identity/executable and localized InfoPlist.strings. Verify the final outer bundle with
   `codesign --verify --deep --strict --verbose=2` and the existing nested-native verification procedure from #2303.
   Test both local ARM64 and the normal certificate-signed release path when producing those artifacts.
3. From a hidden/minimized app and with the instance manager open, exercise every File/Go command and shortcut above.
   Check the destination page, existing-window focus, and current account. Confirm Cmd+, opens all Settings.
4. Open task details and filtered lists through ordinary UI links, then use Back/Forward. Navigate after Back and check
   Forward disables. Switch instance/account (including another account on the same instance), reconnect, log out and
   simulate offline; old history must not be available. During setup/approval check disabled states.
5. Decline and accept leaving an unsaved plan through Settings, Back, instance management and Quit. Check native
   Edit/View/Window behavior, relaunch and `propr://` links. Capture the changed native menus, About and Dock as evidence.

## Native tray and menu verification

Use a real Linux desktop panel or the macOS menu bar. Automated tests cover the application-owned activation and window
lifecycle, but a bare Xvfb server has no tray manager and cannot prove shell-owned XEmbed or StatusNotifierItem
activation.

1. Start the desktop app without enabling notifications. Confirm startup does not request notification permission or
   change **Settings → Desktop notifications**. The quiet defaults are **Enable on this device** (master delivery),
   **Task started**, and **Task completed** off; **Task failed** and **Needs attention** are selected but remain inactive
   until master delivery is enabled.
2. Before connecting on Linux, minimize the window and left-click the tray icon twice. Each activation must restore, show,
   and focus the existing ProPR window without opening a menu or creating a second task-list window. Right-click the icon
   and confirm the native menu remains available. Confirm **Open ProPR**, **Switch / Manage Instances…**, and **Quit
   ProPR** work from that menu, while account actions and the notification toggle are disabled. On macOS, confirm ordinary
   menu-bar activation continues to open the native menu.
3. Connect and sign in. Confirm **New Plan**, **Tasks**, **Plans**, **Inbox**, **Switch / Manage Instances…**,
   **Notification Settings…**, and **Pause/Resume Native Notifications** appear in the tray and Linux application menus.
   For the macOS application menu use the section below.
   Task and plan counts must open their matching destinations; unavailable counts must say unavailable rather than zero.
4. Minimize and then hide the window. On Linux, left-click the tray icon after each state and confirm the window is
   restored and focused. Invoke each destination from the tray and application menu and confirm the same restoration
   behavior. In a plan composer, confirm leaving through a native command asks before navigating.
5. Verify `CmdOrCtrl+N`, `CmdOrCtrl+1`, `CmdOrCtrl+2`, `CmdOrCtrl+3`, `CmdOrCtrl+Shift+I`, `CmdOrCtrl+,`, and
   `CmdOrCtrl+Shift+N` on Linux. macOS application shortcuts are listed below.
6. Pause native notifications and confirm the item becomes unchecked and reads **Resume Native Notifications** while
   delivery is disabled. Resume and confirm it becomes checked and reads **Pause Native Notifications** while delivery is
   enabled. Make the same change in Settings and reopen the tray menu (and Linux application menu) to confirm they agree. Per-event choices must remain
   unchanged.
7. Open **Switch / Manage Instances…**, switch through the existing manager, and confirm the next command targets only the
   new instance. Sign out or disconnect and confirm stale counts disappear and account actions disable. Quit and confirm
   the tray is removed and no accelerator acts during shutdown.

For the Linux/XFCE XEmbed acceptance, log into a real XFCE X11 session and ensure the panel's **Notification Area** plugin
is enabled before launching the exact packaged `propr-desktop` executable under test as the desktop user. Do not run it
with `sudo`. Hover the 22×22 ProPR icon and verify its Active work tooltip. Minimize the 640×402 main window, left-click
the icon, and verify that exact window is restored and focused without any popup or extra task-list window. Hide it and
repeat, including two quick successive activations. Right-click the icon and verify the native menu opens below the
top-panel icon and dismisses on the first outside click. Selecting **Open ProPR** must restore and focus the same window;
selecting **Notification Settings…** must route within that window. If the icon or
right-click menu is absent, run `xfce4-panel --restart` in that disposable acceptance session (or log out and back in),
confirm the Notification Area plugin reacquires the tray selection, and repeat before classifying an application failure.

Electron 44 uses separate Linux paths for primary and context activation. ProPR handles the primary `click` event by
dispatching its existing **Open ProPR** action. Right activation does not reach a JavaScript `right-click` event: the
GTK/XEmbed fallback connects `GtkStatusIcon`'s `popup_menu` signal directly to the menu installed by `setContextMenu()`.
Consequently, a working tooltip and left-click restoration but no right-click menu after the panel restart is
shell-boundary evidence to report with the XFCE version, panel plugin list, and physical-pointer result. Bare Xvfb and
XTest-only results are insufficient to override that real-shell result.

## Guided Linux setup

The Linux wizard uses an app-owned private runtime directory and the same setup engine as the CLI. Before starting, make
sure the current user can run `docker info` without an interactive `sudo` prompt and can reach GitHub and the image
registry. Follow the screens to choose GitHub authentication, event intake, coding agents, and an optional user allowlist.

Setup checks prerequisites before stack mutation, initializes the private root, pulls images bound to the desktop
release, configures GitHub and agent authentication, starts the services, and verifies both health and the strict public
desktop discovery contract. That final pre-completion gate requires instance identity, browser pairing, REST bearer, and
Socket.IO bearer capabilities; a legacy `/api/compatibility` response cannot produce a completed local profile.
Interactive authentication opens in an installed terminal
(`x-terminal-emulator`, GNOME Terminal, Konsole, or xterm). The desktop waits for the authentication command itself even
when the terminal delegates work to an existing server process.

**Cancel safely** cooperatively stops the active command and waits for rollback. A failed, cancelled, or process-interrupted
run reopens in recovery. Use **Retry setup** after correcting a transient host problem, or **Review saved choices** when
credentials or other choices need to change. Successful setup continues through the same profile save, strict discovery,
browser pairing, probe, and activation path used by a manual local profile.

## Security model

- The sandboxed renderer has no Node.js, shell, arbitrary IPC, filesystem path, or credential access.
- Pairing device secrets and instance tokens stay in Electron main. Tokens are encrypted with the OS credential facility;
  Linux `basic_text` mode and unavailable secure storage fail closed.
- REST and Socket.IO credentials are injected only for the active exact origin and credential generation. Renderer-supplied
  authorization/cookies and remote response cookies are stripped.
- Discovery, profile switching, relaunch, reconnect, and tunnel rotation revalidate the credential-free public identity
  before any saved bearer can be used.
- Deep links accept only the bounded `propr://connect` and `propr://open` schemas. Unknown, secret-bearing, oversized,
  malformed, and replayed inputs are rejected without raw-input logging.
- Linux setup selections are capability-scoped in the main process. macOS does not construct a mutating local-setup host.

See [Desktop pairing protocol](./desktop-pairing.md) for the wire contract and token lifecycle.

## Troubleshooting

- **No local setup option:** it is intentionally Linux-only. On Linux, install a current package matching the host CPU.
- **Docker absent, down, or permission denied:** install/start Docker and grant the normal user access to its socket, then
  retry. Do not run the desktop application as root.
- **Authentication terminal unavailable:** install one of the supported terminal emulators and retry. Cancelling the wizard
  also cancels the owned authentication child; closing only a server-backed terminal launcher is not completion.
- **Secure storage unavailable:** start an unlocked Linux Secret Service/keyring session. Pairing does not fall back to a
  plaintext credential file.
- **Offline:** restore DNS/network/API reachability and retry the saved profile. The profile is not deleted.
- **Unexpected credential loss:** `desktop.credential_revocation.retry_pending` describes a retry failure,
  not the action that queued the credential. `desktop.credential_decision` records fixed `reason` and
  `outcome` fields for logout, renderer invalidation, authentication probes, and identity checks, without
  recording credentials, account identities, URLs, or transport scopes. Malformed discovery blocks the
  connection attempt while retaining the saved login. Renderer invalidation requires an independent native
  check against the pinned instance and a definitive HTTP 401 token error; network failures and ambiguous
  responses retain the credential. Verified instance identity changes still block the old credential.
  Issue #2298's original retry log cannot establish its initiating action. Isolated regressions cover these
  automatic retirement paths and voice opt-in/opt-out with another account's queued revocation. Desktop
  voice remains Experimental and off by default; its preference and microphone cleanup do not log out.
- **Desktop profile token revoked or expired:** pair the profile again in the browser. A role/allowlist change can also
  require fresh authorization.
- **Repository GitHub authorization required:** `GITHUB_AUTHORIZATION_REQUIRED` and `GITHUB_REAUTH_REQUIRED` identify the
  GitHub grant used for repository access, not the desktop profile token. Sign in with GitHub again in a browser to the
  same ProPR instance, then retry the desktop repository action. Do not remove or re-pair the desktop profile for this
  recovery.
- **Incompatible:** follow the setup recovery action, which names the selected app image and required API contract. Upgrade
  to a desktop-aligned runtime; retrying an unchanged legacy image cannot complete setup. When the incompatible runtime
  is an already-running Desktop-managed stack, use **Restart with aligned runtime**. The app explicitly replaces only
  containers owned by that private stack root and starts the currently packaged images; its bind-mounted database,
  credentials, logs, repositories, and network are retained. Ordinary **Retry setup** continues to leave it untouched.
- **Tunnel root returns 404:** this can be correct. Connect tunnels expose canonical `/api/*` and `/socket.io/*` routes;
  validation uses discovery/status rather than assuming `/` is served.

Before uninstalling on macOS, choose **Quit ProPR** and wait for the app to exit; closing a window does not necessarily quit
the app. Quit normally on Linux as well. Coordinated shutdown stops new work, drains admitted pairing/setup/deep-link
operations, closes transport state, and releases the single-instance lock.

## Release verification

Pull-request validation is secretless and uses the `macos-linux-v1` profile. It builds and exercises Linux x64/arm64 and
macOS x64/arm64 artifacts, requires Windows artifacts to be absent from canonical aggregation, checks architecture, fuses,
install/relaunch/uninstall behavior, protocol delivery, credential persistence/deletion, clean shutdown, and fail-closed
signing/update configuration. Linux x64 also produces deterministic packaged visual/accessibility evidence.

Linux previews use two manual workflows in this order:

The native runtime smoke starts the actual API, daemon, BullMQ worker, and UI from the candidate images. Its disposable
database contains one explicitly configured disabled direct agent, the supported no-work state; unlike an absent agent
configuration, that state does not request the default agent image. The smoke therefore proves the app/UI contracts and
real daemon/worker startup and liveness without mounting the host Docker socket or building an agent image. It does not
claim to validate agent execution. Normal installations with no saved agent configuration still use the default-agent
fallback, and any enabled direct agent still requires its execution image as before.

1. From the `main` branch version of **Preview Runtime Images**, enter a full lowercase commit SHA that is already
   reachable from `main` and leave `operation` set to `prepare`. This default, validation-only operation builds only
   `propr/app` and `propr/ui` on native `linux/amd64` and `linux/arm64` runners, exercises the app desktop-discovery
   contract and UI runtime configuration, and retains checked artifacts for 14 days. It does not log in to Docker Hub
   or publish any tag.
2. Review that run, then dispatch **Preview Runtime Images** again for the same SHA with `operation: publish`. The native
   build and smoke gates run again before the protected publication job becomes eligible for approval. Publication
   preflights both existing full-SHA tags before its first registry mutation. An existing tag is reused only when its
   manifest contains exactly both native Linux architectures and each image config carries the requested
   `org.opencontainers.image.revision` and the `integry/propr` source label; any conflicting tag fails closed. Missing
   images are copied from the verified OCI candidates directly to `propr/app:<full-SHA>` and
   `propr/ui:<full-SHA>`. The job summary emits both `propr/<image>:<full-SHA>@sha256:<manifest-digest>` references.
3. From the `main` branch version of **Desktop Linux Preview Release**, choose `stage-draft`, enter that same SHA, and
   paste the two digest-pinned references into `runtime_app_image` and `runtime_ui_image`. This workflow independently
   resolves each tag and requires both architectures before building only x64/arm64 DEB and RPM assets and creating a
   private draft with `linux-preview.json`, `INSTALL.md`, and `SHA256SUMS`. Missing or unaligned runtime images fail
   preflight instead of silently packaging the older checked-in runtime manifest.

The preview runtime workflow never uses the stable `docker-images.yml` release path. It cannot create version or
`latest` tags, npm packages, stable releases, desktop releases, docs/agent/launcher images, or release assets. Its
source checkout jobs have read-only repository access and no publication credentials; only the reviewed helper and
checksum-bound OCI artifacts reach the publication job.

Before runtime publication is enabled, administrators must create the protected
`desktop-linux-preview-runtime-publication` environment, require reviewers, define the environment variable
`PROPR_DESKTOP_LINUX_PREVIEW_RUNTIME_PUBLICATION_AUTHORIZED=1`, and scope `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
secrets to that environment. The Docker Hub principal needs write access only to the `propr/app` and `propr/ui`
repositories. Protect operationally against moving or deleting full-SHA tags; the workflow will never overwrite a
conflicting one. Configure native `ubuntu-24.04` and `ubuntu-24.04-arm` runners with Docker, and allow the pinned
`regctl` installer action. Do not place Docker Hub credentials in repository-level variables or source-build runner
configuration.

Draft staging never publishes a release or creates a tag. Public preview publication requires a separate
`publish-draft` dispatch, approval through the protected `desktop-linux-preview-publication` environment, its
`PROPR_DESKTOP_LINUX_PREVIEW_PUBLICATION_AUTHORIZED=1` environment variable, and a non-movable
`desktop-linux-preview-v*` tag ruleset. The publication job downloads, hashes, and architecture-inspects the staged
bytes again and publishes them only as a prerelease, never as the latest release. This preview environment contains no
production signing credential. GitHub Actions release write permission, the two native Linux runner labels, the two
published runtime image manifests, environment reviewers, and preview tag protection are the remaining desktop-draft
setup; Apple credentials and macOS/Windows jobs are not involved.

Preview users verify `SHA256SUMS`, install the matching package with `apt install ./<asset>.deb` or
`dnf install ./<asset>.rpm`, and upgrade only after manually downloading a newer preview with
`apt install ./<new-asset>.deb` or `dnf upgrade ./<new-asset>.rpm`. Linux self-update remains disabled and this channel
uses `apt install --reinstall` or `dnf reinstall` when the newer source preview retains the same package version. It
does not configure an apt/dnf repository. A later public stable Linux channel should use signed apt and dnf repositories
after package/repository signing keys, protected signing custody, signed metadata, HTTPS hosting, retention, key rotation,
and bootstrap instructions exist.

Snap and Flatpak remain follow-up candidates, not blockers. Host Docker socket access, Secret Service/keyring custody,
browser and `propr://` Connect handoffs, terminal authentication, and StatusNotifier/XEmbed tray behavior all cross
their confinement/portal boundaries. Do not add classic or broad socket/filesystem access until those behaviors and the
security model have been validated in real installed packages.

Production publication is allowed only from a new protected `desktop-v<major>.<minor>.<patch>` tag at an immutable commit.
Approval-protected jobs sign and notarize both macOS architectures, sign the release manifest, aggregate the exact ten
packages plus `SHA256SUMS` and `desktop-release.json`, and fail closed before publication if any target, hash, signer,
notarization, update, environment, or tag-protection predicate is missing.

The same protected environment must provide digest-pinned `PROPR_DESKTOP_RUNTIME_APP_IMAGE` and
`PROPR_DESKTOP_RUNTIME_UI_IMAGE` references whose full commit tag equals the desktop release commit. Linux jobs verify
that both Docker Hub artifacts exist, and all package jobs embed a generated manifest bound to those digests and the
desktop API compatibility contract. This deliberately makes desktop distribution wait for the corresponding app/UI
image publication instead of falling back to an older version tag.
