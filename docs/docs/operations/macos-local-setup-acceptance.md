---
sidebar_label: "Native macOS local setup acceptance"
title: "Validate native macOS desktop local setup"
description: "Follow macOS local setup acceptance requirements, provisioning evidence, and the remaining native lifecycle and sign-in checks."
---
# Native macOS local setup acceptance

Issue #2969 changes the production wizard and shared host, not a Mac-only replica. Issue #2968 owns the common
production wizard acceptance/zoom coverage. The Mac entry point reuses its existing packaged lifecycle driver.
Do not alter the frozen fd4960f preview, publish, sign, notarize, deploy, or replace an installed release for this check.

## Exact-head acceptance gate

Do not merge on the earlier native results below. The held-pull lifecycle report must
reach `result: 'verified'` for the exact final source revision and its packaged app.
Rerun the native identity test on that revision as well: earlier passes predate the
`openChild`/`fstat` corrections and do not prove absent-child errno handling or linked
child rejection on the current implementation. That native rerun is a hard precondition
for claiming Darwin identity works: `identifyHeldChild` now opens children through the
addon's `openAt` and the pinned algorithm distinguishes `ENOENT` (first-time creation and
`.ready-v1` resume) from every other failure. The Linux-runnable
`directoryDescriptor.native-errno.test.ts` pins the addon's shared errno-to-`code` mapping
(`ENOENT`, `ELOOP`, non-blocking FIFO opens) for the identical C source, but it executes the
Linux build and does not substitute for `localSetupDarwin.test.ts` on the exact head. Keep the real Library ancestry/ACL
check and full provisioning/pairing evidence separate from the held-pull report.

The S43–S50 follow-up environment is Linux without a Docker executable or a native
macOS GUI session. It cannot supply S43's lifecycle/Library evidence, S46's native
identity pass, or S48's full Linux provisioning mode observations. These gates remain
unverified; unit tests and a skipped Darwin test do not satisfy them. For S48, retain
mode observations at all three boundaries specified below, together with the exact
source revision and actual container mount configuration.

## Native evidence at 7cc97e1

PR #2976 comment6104149475 reports native MacBook results for exact
`7cc97e179dbc8832c8e975ae115a2b0e763c7549`:

- Node 22 locked installation and desktop/UI type checks passed. The Darwin identity
  regression passed 1/1 after restoring ordinary checkout file modes. The initial
  archive transport made the tracked broker mode 0775; its authority rejection and
  the subsequent correction are separate evidence.
- Native ARM64 packaging and package/fuse inspection passed. Those checks did **not**
  establish that setup resources existed in `Contents/Resources`.
- The held-pull lifecycle failed before setup: `connectOverCDP` timed out after
  30 seconds. A diagnostic using the same app with a fresh profile reached HTTP
  `/json/version` 200 (Electron 44.0.0 / Chrome 152.0.7977.54), then exited 1 before
  WebSocket connection. Logs showed `desktop.app.ready`, macOS Keychain error
  -25308 (`errSecInteractionNotAllowed`), and `desktop.app.start_failed` /
  `OPERATION_FAILED`. No proxy environment variables were present.

No setup interaction, provisioning, cancellation, or retry has passed on that native
run. The Linux-only chooser and resource gates independently blocked macOS setup at
that revision. Their corrections and automated regressions do not resolve or prove
resolution of the separate Keychain startup failure. Repeat native resource inspection
and the production chooser-to-wizard lifecycle on the repaired revision once startup
succeeds; full provisioning evidence remains outstanding.

## Read-only prerequisites and held-pull lifecycle

In Terminal opened in the logged-in, unlocked macOS GUI session (not SSH, sudo, or a background job), with Node, the repository's Playwright dependency, and Docker Desktop already running:

1. Independently build the current source and its native application. Keep it separate from the existing preview.
2. Run `npx tsx --test packages/cli/src/localSetupDarwin.test.ts`. This uses actual Darwin descriptors and the
   packaged ACL broker in a disposable directory. A skipped Linux run is not native evidence.
3. Set `PROPR_DESKTOP_REAL_MACOS_SETUP_ACCEPTANCE=1` and
   `PROPR_DESKTOP_SETUP_ACCEPTANCE_SOURCE_SHA` to the exact source revision being tested. Run:

   ```sh
   node apps/desktop/scripts/run-packaged-macos-setup-lifecycle.mjs '/absolute/path/propr-desktop.app/Contents/MacOS/propr-desktop'
   ```

The Mac driver preserves the GUI user's HOME for the normal Keychain context. It directly launches the
executable from that GUI Terminal, inheriting its security session; it rejects SSH, non-Aqua, different-console-user,
and noninteractive execution. This is not an `open -n` launch and still needs native validation. Linux continues
using its disposable HOME and existing session allowlist.

App data (`--user-data-dir`), runtime root, XDG directories, agent credential mount paths in the runtime `.env`,
Docker config, stack/network names and loopback ports remain isolated. The driver locates a local Docker socket
by metadata (or explicit `DOCKER_HOST`), without loading the user's Docker config or credential helpers. No
provider credentials are read or copied. Agent installation detection may check default directory existence;
no agents are selected for this held-pull test, and credential mount paths point into the private profile.
The Docker command boundary remains in front of every production setup Docker command.
It compares existing container/network identities before and after. Only read-only Docker commands reach the daemon;
read-only manifest inspection may also contact the registry. The Mac child omits `PROPR_SKIP_REMOTE_IMAGE_CHECK`
even if set in the parent, so production setup admits a pull with compatible cached images too. Source-built
app/UI images remain local inspections. Pulls are held at the command boundary without reaching the daemon
or downloading images, so cancellation, retry, and interrupted relaunch can be observed before GitHub enrollment.
Retry evidence requires exactly one initial OSType host inspection and one new OSType inspection before one
fresh pull execution; architecture probes do not count as daemon host inspections.
No Docker resource is deleted. The report must retain its limitations: **this is not full provisioning, health,
agent compatibility, enrollment, or pairing proof**. Docker-unavailable reports are unverified, not passes.

At each app launch, the driver writes an **unverified** `native-startup-human-review` report and pauses
in Terminal before CDP attachment. Inspect the actual app. If macOS asks for ProPR Safe Storage access,
human approval is required; the harness neither detects nor approves the prompt. Never reset a Keychain,
change trust/permissions, disable safeStorage, or disable the Chromium sandbox. Leave the Terminal and app
running while awaiting a decision, then press Enter to resume that same launch/profile. Enter only starts
the automated checks; it cannot mark the gate passed. Ctrl-C/SIGTERM during this pause aborts the launch
and records failure. To retry after an abort, rerun the command with a new isolated profile. A CDP failure
is not classified as proof of a Keychain cause. Docker-unavailable and GUI-session-unavailable states are
unverified and exit unsuccessfully; lifecycle failures also cannot pass the gate.

The reusable local signing identity reported on the test Mac verifies across two builds; first ProPR Safe
Storage approval remains a separate human prerequisite. The harness does not sign the app or change trust.
This is no claim of Developer ID, notarization, or credential persistence.

Follow-up evidence at e648365 (fdb2031 changes only two tests): locked install, types, native ARM64
package/fuses and 18 packaging regressions passed. Normal `open -n` launch after unlocking reached the
production chooser and first wizard step, with both original screenshots inspected. That proves availability
only. SSH CDP timed out; the GUI Terminal harness run was terminated with exit 143 after a reported Keychain
reset prompt. No reset occurred. Disposable HOME is a hypothesis, not established causality. The revised
harness still requires native cancellation of an admitted held pull, retry with fresh inspection, and
interrupted-relaunch recovery before lifecycle acceptance can be claimed.

Also test the production wizard with Docker Desktop stopped (actionable start guidance) and without the Docker CLI
(actionable installation guidance), then reopen Docker Desktop and retry. Do not change socket permissions or grant
file access to make the checks pass. Confirm a normal Finder launch locates Docker without a terminal-exported PATH.

## Full provisioning proof — separate, explicit native session

Use a fresh app profile and a newly allocated runtime root/stack/network/loopback ports, isolated from existing
containers, networks and profiles. Record the source revision, app hash, Docker engine architecture and actual image
manifest platforms. Do not use the held-pull boundary or synthetic enrollment responses for this session.

Walk the real wizard with keyboard navigation at a narrow window and 200% zoom. Sign in and select the authorized
GitHub installation explicitly; authenticate each chosen agent explicitly. Record daemon and bind-mount errors
truthfully. If file sharing is needed, the user decides whether to grant it in Docker Desktop.

Verify actual image pulls, startup, protected health, stable public identity across relaunch, local profile registration,
and normal browser pairing/instance identity confirmation. On Apple Silicon, additionally run the selected AMD64 agent
under Docker Desktop emulation and record its real authentication/validation result. Never copy provider credentials,
infer success from a discovered installation, or treat a healthy HTTP endpoint alone as pairing proof.

Cancel and retry during provisioning; interrupt/relaunch and verify recovery without duplicate execution. Check that
existing Docker container/network identities and existing desktop profiles are unchanged. Retain the isolated runtime
for review; do not perform destructive cleanup. Full proof remains unverified until these native actions succeed.

## Remaining native evidence and host side effects

This revision's automated Linux regressions are not macOS acceptance. No available result establishes that changing
HOME caused or fixed `errSecInteractionNotAllowed`. Preserve the real HOME and compare the current exact build's
normal GUI launch with the GUI Terminal harness, recording startup outcome and human-observed consent separately.
The earlier successful `open -n` run only proves that earlier build's chooser and first wizard step.

Before acceptance, verify root acquisition and revalidation with both `assertOwnedLocalSetupRoot` and
`RootDirectoryAuthority` under the actual `~/Library/Application Support/propr-desktop/local-runtime` ancestry.
Record ancestor ACLs, including `group:everyone deny delete` on HOME/Library, without removing ACEs or weakening
checks. Use a disposable owned directory under that ancestry without modifying an installed runtime. Retain exact
revision evidence for this check, Keychain startup, keyboard Ctrl-C, held-pull cancellation/retry/relaunch, and full
provisioning separately. These native gates remain outstanding and Linux CI cannot satisfy them.

Real HOME preserves Keychain context but is not complete filesystem isolation. The shared bundle ID can affect
`~/Library/Logs/propr-desktop`, `~/Library/Preferences/dev.propr.desktop.plist`, saved application state, and
LaunchServices registration of `propr://` against the test bundle. Before and after the run, record existence and
modification metadata for those locations and inspect the registered handler/bundle path. Confirm the installed
release still launches and retains its intended URL handler. Report changes; do not delete shared files, reset
Keychain items, or change registrations automatically.

Terminal authentication forwards HOME, Docker endpoint/context/configuration and TLS certificate locations, GH
configuration location, XDG locations, TMPDIR, and the Docker search path using literal shell arguments. Unset host
selectors clear Terminal defaults, preserving context-over-host precedence. Agent credential mounts and additional
non-secret agent settings are explicit login arguments. GH_TOKEN is an optional container environment input, not an
interactive-login prerequisite; GH_TOKEN, GITHUB_TOKEN and Docker auth JSON are deliberately not transferred or
written into command files. Authentication uses the selected configuration and explicit interactive consent.

Published and source-built agent images must declare Linux AMD64; native ARM64 agents are not qualified by this PR.
Already-local images are inspected locally. With remote checks skipped they are reused; otherwise a failed pull
can reuse an image only after its local platform is reverified. This does not make Docker's inspection and execution
atomic: external image deletion or endpoint changes can still cause the later Docker command to fail.

Selected follow-up verification also covers the Library deny-delete ACL policy, first-use root creation,
and root mode revalidation after awaited startup actions in unit tests. These do not replace native evidence.
For the next full Linux provisioning run, record the runtime root mode before startup, after `startStack`,
and after protected health succeeds; it must remain `0700`. Record actual container mounts and any entrypoint
permission changes. The default mounts target root subdirectories (data/logs/repos), not the root itself.
A static review of the host-side `startStack` path (`scaffoldStack`, `.env` writes, identity directory creation,
agent credential directories, `ensureNetworkAsync`/`startStackAsync` in the launcher orchestrator, and the launcher
entrypoint) found no step that changes the root directory's own mode: every `chmod`/`mkdir` targets the `.env` file
(`0600`), the `data`/`logs`/`repos` subdirectories, the identity data directory, or cache/credential directories, and
the compose mounts bind `.env` and those subdirectories, never the root. This review does not replace the observation;
full Linux provisioning for this invariant remains unverified where Docker is unavailable.

## GitHub browser sign-in

Desktop GitHub authentication now uses the browser device flow described in [Desktop GitHub browser sign-in](desktop-github-browser-sign-in.md). Provision the public OAuth client before testing. Prior terminal-handoff acceptance is historical evidence, not acceptance of the new flow; repeat the native packaged journey without `gh` or a terminal, and never capture the native verification code dialog. Agent registry authentication retains its existing terminal handoff.
