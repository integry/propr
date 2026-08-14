# Darwin directory operations

`directory-operations.c` is the complete source for the small N-API helper used
by the Agent Skill installer on macOS. It exposes only audited, dirfd-relative
POSIX operations. The CLI ships prebuilt N-API binaries for Apple Silicon and
Intel Darwin so installing or running `propr` never invokes Python, a compiler,
`node-gyp`, or another host build tool.

The runtime loader selects the artifact by `process.platform` and
`process.arch`, verifies its hard-coded SHA-256 digest before loading it, and
fails closed if the architecture is unsupported, the artifact is absent, or
its bytes do not match. N-API 8 keeps the artifacts compatible with all Node
versions supported by this package (Node 22 and newer).

The checked-in binaries are built from this source with hidden symbols and an
undefined-symbol lookup for Node's N-API and macOS libc symbols. Release CI runs
the real lifecycle and detached-parent race proof on a native arm64 macOS host;
Linux continues to use its traversable `/proc/self/fd` implementation.
