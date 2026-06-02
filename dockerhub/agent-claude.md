# ProPR Claude Code Agent

Execution container for ProPR runs that route work to Claude Code. ProPR starts
this image when a task is assigned to the Claude Code agent.

Most users should start ProPR with `propr/launcher`; the launcher and app service
pull and run agent images as needed.

```bash
docker pull propr/agent-claude:latest
```

Source: https://github.com/integry/propr
