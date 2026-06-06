# ProPR Antigravity Agent

Execution container for ProPR runs that route work to Antigravity. ProPR starts
this image when a task is assigned to the Antigravity agent. The launcher mounts
the host Antigravity CLI state from `HOST_ANTIGRAVITY_DIR`, normally
`$HOME/.gemini`.

Most users should start ProPR with `propr/launcher`; the launcher pulls and
runs this agent image automatically.

## Image

```bash
docker pull propr/agent-antigravity:latest
```

Source: https://github.com/integry/propr
