# ProPR Codex Agent

Execution container for ProPR runs that route work to OpenAI Codex. ProPR starts
this image when a task is assigned to the Codex agent.

Most users should start ProPR with `propr/launcher`; the launcher and app service
pull and run agent images as needed.

```bash
docker pull propr/agent-codex:latest
```

Source: https://github.com/integry/propr
