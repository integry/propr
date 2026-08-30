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
Windows x64 broker receives all of the caller's already-open objects as
inherited handles and is given no target pathnames. It binds index, expected
kind and actual object type while reading owner/protected-DACL/ACE state and
the full `FILE_ID_128` twice. Its separate setup mode can establish the
narrowly trusted DACL through handles opened before any mutation.

All broker outputs are fixed-version bounded JSON. The runtime resolves them
only inside the packaged CLI native directory and reads them through a held
non-symlink descriptor. After a hard-coded SHA-256 check, execution uses only
those held bytes staged into a randomized private capability, never the
packaged pathname; Windows additionally protects and self-inspects the staged
directory and executable through inherited handles. Both held identities and
digests are revalidated after execution. Missing, unsupported, malformed,
truncated, timed-out, signaled, or replaced brokers fail closed. The checked-in
release artifacts are cross-built with Zig 0.13.0 for `aarch64-macos`,
`x86_64-macos`, and `x86_64-windows-gnu`; runtime installation never invokes a
compiler or PowerShell.
