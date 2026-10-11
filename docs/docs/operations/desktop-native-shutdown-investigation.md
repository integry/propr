# Native Linux shutdown investigation (#2973)

Status: **root cause unconfirmed; native fix and Ubuntu qualification remain open**.
The PR adds opt-in evidence capture and now updates Electron for a known Linux
environment race. This is not a confirmed fix for the original SIGSEGV. Keep #2973 open pending original native crash evidence, causal attribution and
source-bound native qualification.

## Retained evidence

Historical native Ubuntu x64 smoke runs intermittently exited with SIGSEGV after
readiness and ordered shutdown through `final-quit`. The corrected smoke harness
preserved the primary signal instead of replacing it with cleanup ENOTEMPTY.
Passing attempts did not invalidate the failure. Original logs, frozen artifact
identifiers and operator-session details remain in the issue and PR review record.

The kernel report and conditional symbolization against an installed libc suggested
`getenv`, but supplied no original caller stack or core. That is a diagnostic lead,
not causal proof. `final-quit` records entry to `app.quit()`; it does not prove
native destruction completed or the process exited zero.

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

Unit coverage exercises capture authorization, private external retention,
unchanged smoke launch contracts and ordered shutdown. It does not reproduce the
native crash or qualify a platform. Historical local failures and reruns remain
in the review record and are not replaced by later passing results.

## Runtime follow-up

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
life as 2027-03-02. The runtime update retains the existing sandbox/fuse configuration and private
capture protections.

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

For the final candidate source, repeat the locked install, typecheck, full desktop
suite, native package/fuse inspection, complete unmodified four-launch smoke with
capture and a separately declared ordinary run. Retain source-bound packaged
acceptance and native platform gates in [the desktop README](https://github.com/integry/propr/blob/main/apps/desktop/README.md#packaged-visual-and-accessibility-acceptance).
Bind every result to the rebuilt source revision, lockfile, package hashes,
architecture and actual runtime versions. Prior-source acceptance cannot qualify
the final head. Linux evidence does not qualify macOS. Finite passing runs cannot
establish that the original shutdown SIGSEGV is fixed or close #2973.

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
the profile tree. The launcher checks this contract before spawning; the application revalidates it
at use time. Invalid capture configuration fails the launch.

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
