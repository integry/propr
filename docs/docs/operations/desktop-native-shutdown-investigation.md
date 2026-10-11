# Native Linux shutdown investigation (#2973)

Status: **root cause unconfirmed; native fix and Ubuntu qualification remain open**.
The PR adds opt-in evidence capture and now updates Electron for a known Linux
environment race. This is not a confirmed fix for the original SIGSEGV. No
original native stack, core, minidump, frozen executable, or access to gram is
available in the implementation workspace. Keep #2973 open pending causal
evidence and source-bound native qualification.

## Retained evidence

The issue reports Ubuntu 20.04.6, native x64, real X11, production
`gnome_libsecret`, and Node 22.23.3 build dependencies. The application source
was frozen at `fd4960f901a589151bc226befd95305d558aa110`.

- At 00:53 UTC the original unmodified full smoke passed all four isolated
  launches. This does not invalidate the intermittent failure.
- At 01:00:26 UTC the PR2967 harness at
  `efa6cff104596f72e4319f3b2cb8e313a8a0958b` failed on its first launch against
  that same frozen app, after readiness and ordered shutdown through
  `final-quit`: `Packaged desktop exited with code null (signal SIGSEGV)`.
- The kernel entry at local 04:00:28 names `ThreadPoolForeg[412960]`, a general
  protection fault at `7f666f8b0f4d`, stack pointer `7f666b8b98d0`, and
  `libc-2.31.so[7f666f88d000+178000]`.
- PR2967 support tests passed 20/20 on that host. Its corrected harness retained
  the primary SIGSEGV instead of replacing it with cleanup ENOTEMPTY. This was
  mixed-source harness validation, not validation of a rebuilt PR application.
  An earlier missing workspace dependency link was corrected before launch.
  The cause of the earlier failure obscured by ENOTEMPTY remains unknown.

The kernel entry identifies neither a libc function nor its caller. A mapped
segment address without the matching ELF layout/build ID, registers, and stack
is insufficient to attribute this to libc, libsecret, Chromium, or app teardown.
The thread name is not a backtrace. `final-quit` records entry to `app.quit()`;
it does not prove that native destruction completed or the process exited zero.
The supplied evidence does not specify exact Electron, Chromium, or libsecret
versions for the frozen binary; do not infer them from the current checkout.

## Code inspection and local validation

`DesktopCredentialService.dispose()` closes admission, clears the active
credential binding, aborts operations, then waits for admitted work and queued
profile mutations. `ProfileStore.close()` closes admission and waits for its
mutation queue. The shutdown coordinator bounds these drains, disposes session
hooks and IPC, destroys the window, and calls `app.quit()`. The safeStorage
encrypt/decrypt adapters are synchronous Electron calls. These observations do
not rule out outstanding native Chromium work or a native library lifetime bug.
These observations alone did not justify changing this order or inserting sleeps.
The later upstream environment-race evidence below supports a runtime update,
but does not establish that race as the cause of the original shutdown crash.

The initial diagnostic implementation environment was Debian 12 x64, glibc
2.36-9+deb12u14, Node 22.23.3. At that time the checkout locked Electron 44.0.0, but its native
binary and a packaged app are absent. There is no display server, GDB, or
coredumpctl in this workspace. Native reproduction and native crash capture
were therefore **not run**, rather than run successfully without reproducing.
Unit coverage exercises capture authorization, private external retention,
unchanged smoke launch contracts, and the real coordinator with normal quit,
in-flight drain, reentrant quit during window destruction, and forced timeout.
This is not a native-crash regression test or platform qualification.

Initial diagnostic validation on this workspace (before the runtime update):

- `npm run typecheck --workspace @propr/desktop`: passed.
- The two new `native-shutdown-diagnostics` test files: 6/6 passed.
- Combined diagnostics, IPC lifecycle, pairing response lifecycle, smoke
  authorization and smoke support run: 62/64 passed. Existing pairing cases
  `start-header` and `activate-body` failed at service initialization (line 321),
  returning `{ status: 'degraded', retryPending: true }` instead of `ready`,
  before exercising shutdown. The startup path has a 12-second aggregate
  deadline; the host was heavily loaded. Load is a possible contributor, not a
  proven explanation for these failures.
- A single diagnostic rerun filtered to `start-header`, after the build
  completed, passed 1/1. The original failures remain recorded; the combined
  run is not green. No timeout or pairing fixture was changed, and
  `activate-body` was not retried.

## Runtime follow-up (2026-10-11)

The gram operator reports Ubuntu 20.04.6 and glibc `2.31-0ubuntu9.18`.
Subtracting the executable VMA and adding the ELF executable segment address,
`0x7f666f8b0f4d - 0x7f666f88d000 + 0x22000 = 0x45f4d`, maps the original
instruction to `getenv+0xad` (`cmp (%r12),%bp`) against the installed libc.
Its build ID is `5792732f783158c66fb4f3756458ca24e46e827d`; the operator reports
that its executable segment span matches the kernel report. This is conditional
symbolization against the currently installed library, not the original core or
caller stack and not causal proof.

[Electron 44.3.0](https://github.com/electron/electron/releases/tag/v44.3.0)
includes [44.x backport #53509](https://github.com/electron/electron/pull/53509)
of [upstream #53491](https://github.com/electron/electron/pull/53491).
The Linux executable interposes environment writers to keep published arrays
alive on glibc before 2.41, preventing concurrent native `getenv` reads from
accessing a freed array. On glibc 2.41+ it delegates to libc. This addresses a
known race relevant to the new lead; it does **not** establish an original caller
or fix macOS's libc environment race.

The desktop minimum is now `^44.7.0`, locked to **44.7.0**, the latest stable
44.x release at investigation time. This keeps the existing major and includes
the fix plus subsequent maintenance updates. The
[44.x support schedule](https://releases.electronjs.org/schedule) lists end of
life as 2027-03-02. Only the Electron requirement and resolved package metadata
change; existing transitive versions, sandbox/fuse configuration and private
capture implementation are retained.

Exact upstream runtime versions from the
[Electron release index](https://releases.electronjs.org/releases.json):

| Role | Electron | Chromium | Embedded Node |
| --- | --- | --- | --- |
| Previous lock | 44.0.0 | 152.0.7977.54 | 24.18.1 |
| First patched 44.x | 44.3.0 | 152.0.7977.78 | 24.20.0 |
| Updated lock | 44.7.0 | 152.0.7977.130 | 24.21.0 |

These are release metadata, not measured versions of the original frozen app.
Native acceptance must still record the rebuilt artifact's actual runtime
versions. Build-time Node in this workspace remains 22.23.3.

### Regression provenance and remaining acceptance

Use the official [environ-write-race.js fixture](https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/spec/fixtures/api/environ-write-race.js),
unchanged, from the 44.7.0 source commit
`61f55c4ce540416b3e43f75f6c0f125d22e5e908`.
Its SHA-256 is
`81fd87d0ecfc16fe0b484bef8d56265406011a0908c1241d5c22d1c7ada3a976`.
This exercises real native reads via a worker's `os.homedir()` while the main
thread adds 2,000 environment variables. It is not a JS mock of the fix.
The upstream backport's `spec/api-process-spec.ts` requires **all three**:
stdout trimmed to exactly `done`, code 0, and signal null, after worker exit.
Exit 0 alone is insufficient because a worker timeout also reaches `app.exit(0)`.

On gram, run those same fixture bytes with the official 44.0.0 and 44.7.0 Linux
binaries in the same qualified unprivileged session; verify the upstream binary
checksums and record binary/fixture hashes and libc build ID. A downloaded copy
inside this repository must use `.cjs` (identical contents) to avoid the root's
ES-module package scope. Launch as `"$electron_binary" "$fixture_path"` without
sandbox bypasses, `ELECTRON_RUN_AS_NODE`, or injected libraries. Predeclare the
attempt count, retain every exit/signal/stdout/stderr and any external timeout,
and apply the upstream assertion to each attempt. The operator's independent
before/after run is pending; no result is inferred here.

The operator reports 32 successful native launches of diagnostic source
`f8181fc` (16 capture, 16 ordinary), without reproducing the original crash.
Those qualify neither this runtime update nor the original root cause.
For the updated PR source, repeat the locked install, typecheck, full desktop
suite, native package/fuse inspection, complete unmodified four-launch smoke
with capture and a separately declared ordinary run. Retain the existing
source-bound packaged acceptance and native platform gates in
[the desktop README](https://github.com/integry/propr/blob/e74a8f4ebc56c5cd704311f1a7573ccf2698c912/apps/desktop/README.md#packaged-visual-and-accessibility-acceptance).
Bind all results to the exact rebuilt source revision, lockfile, package hashes,
architecture and runtime versions; do not combine an old app with a new harness
or carry forward f818 acceptance. Linux evidence does not qualify macOS.
Obtain fresh independent review of this runtime diff and its acceptance evidence
before merge. No publishing or host-library/security changes are part of this
follow-up. Finite passing runs, including the upstream fixture, cannot by
themselves establish that the original shutdown SIGSEGV is fixed or close #2973.

### Runtime-update workspace validation

- `npm ci --ignore-scripts --no-audit --no-fund`: passed; Electron installed with
  its explicit `node node_modules/electron/install.js` installer. Installed npm
  package and distribution version file both report 44.7.0.
- `npm run typecheck --workspace @propr/desktop`: passed.
- `npm test --workspace @propr/desktop`: 1,080 tests, **1,042 passed, 38 skipped,
  0 failed**, 0 cancelled. Skipped native/display and opt-in platform coverage
  is not native qualification. The prior diagnostic-run failures above remain
  historical evidence; no fixtures, timeout or retry policy were changed.
- `npm run package --workspace @propr/desktop` and
  `npm run smoke:inspect --workspace @propr/desktop`: passed for Linux x64;
  executable/fuse inspection passed and the packaged version file is 44.7.0.
  This local package is from base `f8181fc86375cb213b28cbcb61920c611432e510`
  plus this runtime diff, not a qualified-host acceptance artifact. SHA-256:
  lockfile `6595f11797cad0660146317e3f7fe7bfd0ebcd8cfb095ca53c5458fe670c6108`,
  packaged executable `24f81f81475856a908ceeda392f0ac366730370ea71bef0fa9fa1de93faf04ac`,
  `app.asar` `a1f11892bb6fe9c55d8d63f5f3052c93fb71afae998ce90fd478a390b1359154`.
- Manifest/lock consistency check: only the desktop requirement and Electron
  package metadata differ; no transitive package additions, removals or updates.
  `readelf --dyn-syms --wide node_modules/electron/dist/electron` confirms defined
  global `setenv`, `unsetenv`, `putenv` and `clearenv` exports in the new Linux
  binary. This is structural confirmation, not execution of the regression.
- One direct upstream fixture attempt, with no sandbox bypass: **blocked before
  fixture execution**, signal SIGTRAP, empty stdout. Electron reported that this
  container's SUID sandbox helper is not configured for native launch. This is
  an environment failure, not a race-test pass or reproduction of the original
  SIGSEGV. No permission/security changes or retry were made. The container also
  lacks a display server. Native smoke and acceptance remain pending on qualified
  hosts, which must repeat package/fuse inspection for their exact artifacts.
- Fresh independent implementation review after the runtime update found no
  actionable issues in dependency scope, upstream provenance, security settings
  or evidence claims. Review of qualified-host acceptance remains pending.

## Capture on the qualified host

Build the changed application using the existing packaging procedure and record
its source/package hashes separately from the frozen failing artifact. Preserve
the original sanitized logs and frozen package. Use the existing unprivileged
synthetic-fixture smoke procedure, display, isolated profiles and keyring session.
Do not use real credentials or change host libraries, permissions, sandboxing,
fuses, GPU flags, or timeouts for diagnosis.

From `apps/desktop`, in that already-qualified session:

```sh
crash_evidence_dir=$(mktemp -d /tmp/propr-native-shutdown-evidence-XXXXXXXX)
PROPR_DESKTOP_NATIVE_CRASH_DIRECTORY="$crash_evidence_dir" npm run smoke:package
```

Keep the command's actual exit status. The launcher adds only
`--propr-native-crash-directory=<directory>` to each existing smoke mode. The
application accepts it only after the existing packaged smoke authorization
succeeds, on Linux, with an existing owned 0700 canonical directory outside
the profile tree. Invalid capture configuration fails the launch.

Before ready, Electron's crash reporter starts with `uploadToServer: false`,
no submission URL, and `ignoreSystemCrashHandler: false`. Each process gets a
new private `launch-*` directory containing a runtime version/PID manifest and
a `dumps` directory. A fixed `propr_shutdown_phase` annotation tracks shutdown
through `will-quit`. No credential, environment, URL, profile data, or arbitrary
error is added as an annotation. Electron documents this local storage and
startup behavior in its [crashReporter API](https://www.electronjs.org/docs/latest/api/crash-reporter).

Crashpad may include memory in a dump; treat **all raw evidence as private** even
with synthetic fixtures. Never post dumps or raw debugger output to GitHub.
The evidence root is operator-owned and deliberately survives harness-owned
profile cleanup. Retain it privately until diagnosis is complete, then remove
only that root. Do not feed dumps into public log/artifact publication. Capture
does not suppress signals, retry launches, change success assertions, or bypass
the existing scan for plaintext credentials under userData.

On failure, retain every launch directory and the full sanitized harness log.
Find minidumps recursively under `dumps`; Crashpad's internal layout is not an
API. Absence of a dump does not negate a SIGSEGV, particularly late in process
teardown. Use an already-available system core if local default permissions
allow access; do not change ptrace/core settings or request elevated access.

## Required diagnosis and regression evidence

1. Record `/etc/os-release`, kernel, architecture, the manifest's Electron,
   Chromium and embedded Node versions, package/fuse checks and hashes, plus
   exact installed versions and ELF build IDs for libc, libsecret, GLib/GIO and
   every module appearing in the crash stack. Build-time Node is separate from
   Electron's embedded Node.
2. Symbolicate offline using matching Electron symbols and exact module build
   IDs, not symbols from a newer package. Retain the faulting thread, instruction,
   registers, module mappings/load biases and all-thread backtrace. If symbols
   or an artifact are missing, record that explicitly. Use existing unprivileged
   tools; no library replacement, system setting changes or sandbox bypass.
3. Attribute the crash using the stack and ownership/lifetime evidence. Check
   whether the fault occurs in Chromium thread-pool teardown, credential-library
   work, or an app-triggered native operation. A last JS phase alone cannot decide
   this. Add a targeted failing-before/passing-after regression only once a
   mechanism is established; preserve the original failure as evidence.
4. Run the full unmodified assertion suite against the rebuilt fix, including
   release guard/normal quit, transport success, repeated quit and forced timeout,
   credential protection/auth assertions and cleanup. Every observed signal or
   nonzero exit remains a failure even after `final-quit`. Predeclare any repeat
   count for intermittent reproduction and retain all outcomes; do not retry
   until green. Also run without capture because instrumentation changes timing.
5. Report all attempts, including non-reproduction and unresolved uncertainty.
   A successful host run qualifies that configuration only; it does not establish
   whole-platform support or erase the previously observed failure.

The PR2967 cleanup/diagnostic implementation, setup visual coverage, macOS setup
and nightly fixture timeout work are outside this change.
