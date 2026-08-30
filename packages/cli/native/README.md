# Native directory operations

`directory-operations.c` is the complete source for the small N-API helper used
by the Agent Skill installer on macOS and for atomic sibling moves on Linux. It
exposes only audited, dirfd-relative POSIX operations. Sibling moves use
`renameatx_np(..., RENAME_EXCL)` on Darwin and
`renameat2(..., RENAME_NOREPLACE)` on Linux. The CLI ships prebuilt N-API
binaries for arm64 and x64, so installing or running `propr` never invokes
Python, a compiler, `node-gyp`, or another host build tool.

The runtime loader selects the artifact by `process.platform` and
`process.arch`, verifies its hard-coded SHA-256 digest before loading it, and
fails closed if the architecture is unsupported, the artifact is absent, or
its bytes do not match. N-API 8 keeps the artifacts compatible with all Node
versions supported by this package (Node 22 and newer).

The checked-in binaries are built from this source with hidden symbols and
runtime lookup for Node's N-API and operating-system symbols. Release CI runs
the real lifecycle and detached-parent race proof on native Linux and arm64
macOS hosts. Linux continues to use its traversable `/proc/self/fd`
implementation for operations other than the atomic move.

`darwin-authority-broker.c` and `windows-authority-broker.c` are the complete
sources for the Connect authority brokers. The Darwin broker receives the
caller's pinned object as inherited fd 3 and uses only `fstat`,
`acl_get_fd_np(ACL_TYPE_EXTENDED)`, and `acl_to_text` on that handle. Native
NULL/ENOENT means the held object has no extended ACL and is encoded as an
empty ACL document; every other failure remains fatal. For inspection, the
Windows x64 broker receives all of the caller's already-open objects through
handles duplicated from its trusted bootstrap parent and is given no target
pathnames. It binds index, expected kind and actual object type while reading
owner/protected-DACL/ACE state and the full `FILE_ID_128` twice. Its separate
setup mode can establish the narrowly trusted DACL through handles opened
before any mutation.

All broker outputs are fixed-version bounded JSON. The runtime resolves them
only inside the packaged CLI native directory and reads them through a held
non-symlink descriptor. After a hard-coded SHA-256 check, broker execution uses
only held bytes staged into a randomized private capability.

`windows-authority-bootstrap.c` is a separately committed immutable bootstrap
authority. Its source and x64 PE carry independent hard-coded SHA-256 pins and
are not outputs of the helper build. It obtains Windows, system-Windows and
System32 paths directly from `GetWindowsDirectoryW`,
`GetSystemWindowsDirectoryW` and `GetSystemDirectoryW`, removing the circular
dependency on a newly built broker. At runtime it retains a `FILE_SHARE_READ`
lease over the packaged broker, binds full volume/`FILE_ID_128`/SHA-256,
ordinary-file and protected owner/DACL state, and in production binds the exact
Authenticode leaf and SPKI from the WinVerifyTrust provider chain. It creates
the packaged broker suspended, assigns a kill-on-close job,
reopens and revalidates the loaded image, and retains all leases through exit.
The Windows-only helper build also uses its `lease-build-inputs-v1` boundary:
an independently hash-bound manifest names every exact compiler, linker,
reference, staged source, include, library and generated object byte sequence.
The bootstrap opens each input with `FILE_SHARE_READ` only, rejects reparse,
foreign-owner or broadly writable ACL state, and requires each invoked tool's
pre-authorized exact embedded-signature leaf/SPKI pair. Signature kind is part
of the lease record: catalog-only, unsigned, wrong-leaf and wrong-key images
fail rather than changing trust modes. It signals readiness only after all
leases exist and retains them until the explicitly named tool has exited.
Unsigned freshly built validation images are marked as data inputs and never
produce or claim signer pins.

The bootstrap provenance is independently reproducible: source SHA-256
`9c78ab7d06b43dcee72420ec6442fc639b5542a8ef76be3a46d281843d43ef72`,
PE SHA-256
`2373622afcd21231ff5bd2953f5896af1eb8565bbe395eeb5128b0591145ea17`,
and Zig 0.13.0 Linux x86_64 archive SHA-256
`d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea`.
From the repository root, the exact build is
`SOURCE_DATE_EPOCH=0 zig cc -target x86_64-windows-gnu -O2 -s -municode packages/cli/native/windows-authority-bootstrap.c -ladvapi32 -lbcrypt -lcrypt32 -lwintrust -o packages/cli/native/prebuilds/win32-x64/connect-authority-bootstrap.exe`.
The fixed epoch plus stripped output makes two clean invocations byte-for-byte
identical; package verification also cross-checks this PE hash against the
generated authority manifest after both `npm pack` and `npm install`.

`windows-authority-supervisor.cs` is the complete persistent Windows authority
source. It is compiled in an explicit Windows-only build step into a
deterministic AnyCPU PE and is never compiled at runtime. The build emits a
canonical manifest binding the exact source and helper SHA-256, managed AnyCPU
metadata, protocol version, compiler and reference provenance, and either the
explicit `unsigned-validation` trust mode or production Authenticode leaf/SPKI
pins plus a detached Ed25519 manifest signature. Production discovery rejects
an absent helper, an unsigned manifest, a non-canonical manifest, a bad
signature, or any hash/metadata mismatch. Thus an installed CLI never needs
PowerShell, `Add-Type`, `csc.exe`, a compiler temp directory, or source
transport.

`windows-connect-authority-service.cs` and `windows-connect-authority.wxs`
close the earlier first-CreateProcess gap. The signed MSI installs the narrowly
scoped `ProPRConnectAuthority` service per-machine under Program Files with a
protected SYSTEM/TrustedInstaller-only mutable DACL and automatic LocalSystem startup. Repair
reasserts the exact component; major-upgrade rules reject downgrades, and
uninstall stops and removes the service through Windows Installer. The npm
package contains the installer for an administrator to install, repair, or
remove, but the standard-user CLI never invokes MSI or elevates itself.

Before any package native image is executed, the CLI connects to the fixed
least-privilege named pipe and sends one canonical 4 KiB-bounded launch
authorization. The service rejects anonymous/SYSTEM clients, wrong sessions,
stale versions, replayed request IDs, invalid UTF-8/schema/framing, nonordinary
images, hash changes, and (in production) any broker not signed by the same
fixed leaf/SPKI as the service. It holds a no-write/no-delete file lease while
the existing anonymous-handle launch chain starts, then binds the reported
child PID, loaded image path, volume, full `FILE_ID_128`, hash, signer pins,
SYSTEM identity, and protected service ACL before acknowledging confirmation.
The CLI releases that OS lease only after the broker's existing self-proof
barrier. A missing, stopped, crashed, stale, or uninstalled service produces a
fixed install/repair action and never falls back to the old package-first path.

The CLI never passes the supervisor path to `child_process.spawn`. It starts
the manifest-bound x64 native broker in `launch-supervisor-v2` mode with an
empty environment, binary anonymous stdin/stdout, and held broker/supervisor
handles. The native launcher opens the supervisor with `FILE_SHARE_READ` only,
compares full file identity and SHA-256 with the inherited held object, creates
the supervisor suspended with the inherited anonymous pipes, assigns its
kill-on-close job, opens the loaded process image, and repeats the full
identity/hash proof before resuming. The helper then requires its actual
Authenticode leaf/SPKI to equal both the signed manifest arguments and its
embedded signing-policy resource. Launcher/helper leases and jobs remain open
through protocol exit; x64 and arm64 both execute the same AnyCPU helper after
the x64 native API boundary. Stdout is exclusively the strict
4-byte-length-prefixed protocol; stderr is required to remain empty. The
parent-bound supervisor retains the broker's write/delete-denying image lock,
full identity and hash for the cached capability lifetime, hardens its process
DACL, and enters a kill-on-close Job Object before READY. Readiness,
pre-launch, post-response, and shutdown use fresh request IDs and strict
sequence/PID/full-identity/digest binding. There is no runtime compiler
workspace to publish or clean up.
The parent uses only the documented asynchronous ChildProcess streams with an
incremental bounded parser, backpressure-aware writes, abort propagation, and
startup/request/shutdown deadlines; it never extracts private pipe descriptors
or performs synchronous filesystem I/O on a pipe.
There is no reconnectable IPC name, environment secret, readiness file, or stop
file. Subsequent bounded
broker batches inherit the caller's held setup or inspection descriptors
directly and are serialized. Their 4 KiB stdin protocol carries only a fixed
version, random request ID, operation, count, and fixed entry kinds—never a
pathname or secret—and the response echoes the request ID while binding every
index, kind, DACL, and full 128-bit file identity. The supervisor-held image
identity and lock are challenged on both sides of every batch, and the staged
and packaged held identities and digests receive supplemental revalidation. A
crash, timeout, EOF, extra output, protocol error, or image mismatch destroys
the capability, fails that request, and requires fresh authentication before a
later request. Normal exit sends the authenticated stop exchange, reaps the
supervisor, and removes the staged capability; unexpected parent death also
closes its locks.
Missing, unsupported, malformed, truncated, timed-out, signaled, or replaced
brokers and an unavailable system bootstrap fail closed. The checked-in release
artifacts are cross-built with Zig 0.13.0 for `aarch64-macos`, `x86_64-macos`,
and `x86_64-windows-gnu`; runtime installation never invokes a compiler.
