# ProPR Agent Base

Shared base image for ProPR coding agent execution containers. It contains common
runtime tooling used by the agent-specific images, based on Debian slim with
glibc compatibility for common prebuilt developer tooling.

The image pins `node:20-bookworm-slim` rather than the moving `node:20-slim`
alias so Debian release upgrades are deliberate. It also includes
`build-essential` in the shared base so agent containers can compile native
addons and local development tools without per-repository setup steps.

Most users do not run this image directly. It is used as the base for:

- `propr/agent-claude`
- `propr/agent-codex`
- `propr/agent-antigravity`
- `propr/agent-opencode`
- `propr/agent-vibe`

Source: https://github.com/integry/propr
