# Native Linux shutdown investigation (#2973)

Status: **root cause unconfirmed; native fix and Ubuntu qualification remain open**.
This change adds opt-in evidence capture, not a claimed SIGSEGV fix. No native
stack, core, minidump, frozen executable, or access to the validation host was
available in the implementation workspace.

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
No evidence supports changing this order, inserting sleeps, or upgrading a
dependency as the fix yet.

The implementation environment is Debian 12 x64, glibc
2.36-9+deb12u14, Node 22.23.3. The checkout locks Electron 44.0.0, but its native
binary and a packaged app are absent. There is no display server, GDB, or
coredumpctl in this workspace. Native reproduction and native crash capture
were therefore **not run**, rather than run successfully without reproducing.
Unit coverage exercises capture authorization, private external retention,
unchanged smoke launch contracts, and the real coordinator with normal quit,
in-flight drain, reentrant quit during window destruction, and forced timeout.
This is not a native-crash regression test or platform qualification.

Validation on this workspace:

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
