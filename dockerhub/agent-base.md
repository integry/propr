# ProPR Agent Base

Shared base image for ProPR coding agent execution containers. It contains common
runtime tooling used by the agent-specific images, based on Debian slim with
glibc compatibility for common prebuilt developer tooling.

Most users do not run this image directly. It is used as the base for:

- `propr/agent-claude`
- `propr/agent-codex`
- `propr/agent-antigravity`

Source: https://github.com/integry/propr
