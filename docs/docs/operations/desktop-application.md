---
title: Desktop application
---

# Desktop application

ProPR Desktop runs the ProPR Web UI in a sandboxed Electron window and connects it to one or more ProPR instances. It is
a client: agents, repositories and task state stay on the instance you connect to. On Linux it can also install and run a
local ProPR stack for you. The desktop app does not change the browser Web UI, CLI, API or self-hosted behavior.

## Platforms

| Platform | Packages | Connect to an instance | Guided local setup |
| --- | --- | --- | --- |
| Linux x64 | DEB, RPM, ZIP | Yes | Yes |
| Linux arm64 | DEB, RPM, ZIP | Yes | No: the `propr/agent` image is published for `amd64` only |
| macOS Intel | DMG, ZIP | Yes | No |
| macOS Apple Silicon | DMG, ZIP | Yes | No |
| Windows | Not available yet | | |

## Download

Desktop packages are published as assets on the ProPR
[GitHub Releases](https://github.com/integry/propr/releases) page. Asset names follow
`ProPR-Desktop-<version>-<os>-<arch>.<ext>`, for example `ProPR-Desktop-0.9.0-linux-x64.deb` or
`ProPR-Desktop-0.9.0-macos-arm64.dmg`. Choose the package that matches your operating system and CPU (`x64` for
Intel/AMD, `arm64` for ARM and Apple Silicon).

Each release includes a `SHA256SUMS` file. Verify downloads before installing:

```sh
sha256sum --check --ignore-missing SHA256SUMS         # Linux, from the download folder
shasum -a 256 ProPR-Desktop-0.9.0-macos-arm64.dmg     # macOS: compare with the SHA256SUMS line
```

## Install

### Linux

```sh
sudo apt install ./ProPR-Desktop-0.9.0-linux-x64.deb   # Debian, Ubuntu
sudo dnf install ./ProPR-Desktop-0.9.0-linux-x64.rpm   # Fedora, RHEL family
propr-desktop                                          # launch (or use your application menu)
```

Use `arm64` in the file name on ARM hosts. Pick either the DEB or the RPM for a machine, and don't mix them. Pairing
stores credentials in the Secret Service keyring (GNOME Keyring, KWallet and similar), so start an unlocked keyring
session before connecting. Don't run the app as root.

### macOS

Open the DMG and drag **ProPR** to Applications, or unzip the ZIP archive and move the app to Applications.

The macOS builds are not yet signed with an Apple Developer ID or notarized, so Gatekeeper blocks the first launch.
macOS 15 Sequoia and later removed the Control-click → **Open** shortcut. To allow the app:

1. Open **ProPR** once. macOS reports that it can't verify the app; click **Done**.
2. Open **System Settings → Privacy & Security** and scroll to **Security**.
3. Click **Open Anyway** next to the ProPR message (it appears for about an hour after the blocked attempt), then confirm
   with your login password.

macOS remembers the exception, and later launches open normally. See Apple's guide to
[opening an app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

Alternatively, remove the quarantine attribute from Terminal. The app bundle on disk is named `propr-desktop.app`, even
though Finder shows **ProPR**:

```sh
xattr -dr com.apple.quarantine /Applications/propr-desktop.app
```

Native macOS notifications may not be delivered by an unsigned build.

## First launch and connection

On Linux, choose **Set up this computer** to install a desktop-managed local stack, or **Connect to an existing instance**
to use a stack that is already running. On macOS, connect to an existing instance.

1. Enter the instance address. Remote instances need HTTPS, such as your own host or a ProPR Connect managed tunnel
   (`https://t-<instance>.propr.dev`). Plain HTTP is accepted only for loopback development addresses.
2. The app checks compatibility and the instance's identity before asking you to sign in.
3. Select **Sign in in browser** and approve the request in your default browser with your GitHub account. While the app
   waits, **Reopen browser** retries the same approval and **Copy approval link** copies it for another browser.
4. Confirm the **@username** shown in the desktop dialog.

The app receives an instance token, never a GitHub token or password, and stores it encrypted with the operating
system's credential store. A ProPR Connect discovery result or `propr://connect` link opens a confirmation screen; it
never pairs automatically. See [Desktop pairing protocol](./desktop-pairing.md) for the protocol details.

After connecting, select **Connected: _instance name_** to open the instance manager. Add, switch, edit, remove, retry
or re-pair instances there. Offline instances stay saved for retry. A revoked or expired connection asks you to pair in
the browser again. If a managed tunnel's address or identity changes, confirm and pair again.

![Desktop connection editor with display name, instance URL and Connect action](/img/screenshots/0.9.0/desktop-connect.png)

## Saved GitHub accounts

You can save several GitHub accounts, including two accounts on the same instance. In the instance manager, select
**Add account** beside the instance, approve in the browser, and confirm the **@username** in the desktop dialog. If the
browser picks the wrong GitHub identity, cancel and open the approval link in a browser profile signed in to the intended
account. ProPR never collects GitHub passwords or signs the browser out of GitHub.

One account is active per window. Switching accounts reloads the app under the new account; server work already started
by the previous account keeps running. Logging out retires only the active account's credential.

## Guided local setup (Linux x64)

**Set up this computer** installs a ProPR stack managed by the app, using the same setup engine as `propr setup` in the
CLI. Before starting, make sure that:

- Docker is installed and running, and your user can run `docker info` without `sudo`;
- the machine can reach GitHub and Docker Hub;
- a terminal emulator is installed (`x-terminal-emulator`, GNOME Terminal, Konsole or xterm) for interactive GitHub and
  agent logins.

The wizard checks the host before changing anything. You choose GitHub authentication, event intake, coding agents and an
optional user allowlist. Setup then pulls the runtime images that match the desktop release, opens a terminal for
interactive logins, starts the services, verifies their health, and pairs the new local instance automatically.

**Cancel safely** stops the current step and rolls back. A failed, cancelled or interrupted run reopens in recovery: use
**Retry setup** after fixing a host problem, or **Review saved choices** to change credentials or other selections. When
an existing desktop-managed stack runs an incompatible version, **Restart with aligned runtime** replaces only that
stack's containers with the packaged versions and keeps its database, credentials, logs and repositories.

## Version and diagnostics

**About ProPR** shows the app version and a **Copy Version Details** action. **Connection Diagnostics** shows the
desktop app version and the connected instance's version separately. Updating the desktop app does not upgrade a remote instance.

Installation-level **Settings** belong to the connected server. Connection management and diagnostics belong to the app.

## Menus, tray and shortcuts

| Menu | Actions and shortcuts |
| --- | --- |
| ProPR | About ProPR, Settings… (`Cmd+,`), Services and Hide (macOS only), Quit ProPR (`Cmd+Q`) |
| File | New Plan (`Cmd+N`), New Task…, Connect Instance…, Switch Account / Instance… (`Cmd+Shift+I`), Close Window |
| Edit | Native editing |
| View | Toggle Sidebar, zoom, full screen |
| Navigate | Back (`Cmd+[`), Forward (`Cmd+]`), Search / Go To… (`Cmd+K`), Dashboard, Inbox, Plans, Goals, Tasks, Repositories |
| Window | Minimize; on macOS also zoom window and bring all to front |
| Help | ProPR Website, Documentation, Connection Help, Connection Diagnostics…, Report a Problem… |

On Linux, use `Ctrl` in place of `Cmd`. The Linux tray icon and the macOS menu-bar item show task and plan counts and
offer New Plan, Tasks, Plans, Inbox, instance switching, notification settings, and pausing or resuming native
notifications. On Linux, left-clicking the tray icon restores the ProPR window.

Native notifications are off until you enable them in **Settings → Desktop notifications**. Once enabled, **Task failed**
and **Needs attention** are selected by default.

## Updating

- **Linux:** the app does not update itself and there is no apt or dnf repository yet. Download the newer package and run
  `sudo apt install ./ProPR-Desktop-<version>-linux-<arch>.deb` or
  `sudo dnf upgrade ./ProPR-Desktop-<version>-linux-<arch>.rpm`.
- **macOS:** the unsigned builds do not update themselves. Quit ProPR, then replace the app in Applications with the newer
  download.

Saved instances and accounts are kept across updates.

## Security model

- The window's renderer is sandboxed: it has no Node.js, shell, filesystem or credential access.
- Instance tokens stay in the app's main process and are encrypted with the OS credential store (Keychain on macOS,
  Secret Service on Linux). If secure storage is unavailable, pairing fails instead of writing a plaintext file.
- Credentials are sent only to the exact instance they were issued for. Reconnecting, switching instances or a tunnel
  change re-checks the instance's identity before a saved token is used.
- Deep links accept only `propr://connect` and `propr://open`; anything else is rejected.

## Troubleshooting

- **No local setup option:** guided setup is offered on Linux only, and supported on x64.
- **Docker absent, down or permission denied:** install and start Docker, add your user to the `docker` group, then retry.
- **Authentication terminal unavailable:** install one of the supported terminal emulators and retry.
- **Secure storage unavailable:** start an unlocked Secret Service keyring session. Pairing never falls back to a
  plaintext credential file.
- **Offline:** restore network access to the instance and retry. The saved connection is kept.
- **Connection revoked or expired:** pair again in the browser. A role or allowlist change can also require a new approval.
- **Repository GitHub authorization required:** `GITHUB_AUTHORIZATION_REQUIRED` and `GITHUB_REAUTH_REQUIRED` refer to the
  GitHub grant used for repository access, not the desktop connection. Sign in with GitHub again in a browser on the same
  ProPR instance, then retry. You don't need to remove or re-pair the desktop connection.
- **Incompatible runtime:** follow the recovery action in setup. For an existing desktop-managed stack, use
  **Restart with aligned runtime**.
- **Tunnel root returns 404:** this is expected. Connect tunnels serve `/api/*` and `/socket.io/*`, not `/`.

## Uninstall

- **Linux:** `sudo apt remove propr-desktop` or `sudo dnf remove propr-desktop`. Removing the package does not delete a
  desktop-managed local stack or its data.
- **macOS:** choose **Quit ProPR** and wait for the app to exit (closing the window does not quit it), then move the app
  from Applications to the Trash.
