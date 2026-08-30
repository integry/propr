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
non-symlink descriptor. After a hard-coded SHA-256 check, execution uses only
those held bytes staged into a randomized private capability, never the
packaged pathname. On Windows, one bounded System32 PowerShell bootstrap opens
the randomized directory and executable with write/delete sharing denied, binds
the full file identity and SHA-256 through that handle, and establishes and
verifies the exact protected DACL. A parent-bound supervisor retains that
authenticated image lock for the lifetime of the cached capability. Readiness,
pre-launch, post-response, and shutdown exchanges use a random protected named
pipe, HMAC transcripts under a fresh 256-bit parent nonce, a fresh challenge,
and strict sequence/PID/full-identity/digest binding; the nonce never crosses
the pipe, and there is no readiness or stop file. Subsequent bounded
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
