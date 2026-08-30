# Native directory and Darwin ACL operations

`directory-operations.c` is the complete source for the small N-API helper used
by the Agent Skill installer on macOS and for atomic sibling moves on Linux. It
exposes only audited, dirfd-relative POSIX operations. The CLI ships prebuilt
N-API binaries for arm64 and x64, so installing or running `propr` never invokes
Python, a compiler, `node-gyp`, or another host build tool.

`darwin-authority-broker.c` is the macOS Connect ACL diagnostic helper. It
receives the caller's already-held object as inherited fd 3 and uses `fstat`,
`acl_extended_fd_np`, `acl_get_fd_np`, and `acl_to_text` on that same descriptor.
It emits one bounded versioned document, and the CLI verifies the packaged
binary's SHA-256 before running it from a private staged path.

Windows Connect status deliberately has no native helper in this package. It
retains descriptor, reparse-point, replacement, and identity checks and reports
`ACL_DIAGNOSTIC_UNAVAILABLE` when Node cannot safely obtain a same-handle DACL
diagnostic. Windows operations that would need DACL mutation or privileged
launch authority return `WINDOWS_AUTHORITY_REQUIRED` until #1997 lands.
