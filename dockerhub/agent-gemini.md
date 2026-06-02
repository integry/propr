# ProPR Gemini Agent

Execution container for ProPR runs that route work to Google Gemini CLI. ProPR
starts this image when a task is assigned to the Gemini agent.

Most users should start ProPR with `propr/launcher`; the launcher and app service
pull and run agent images as needed.

```bash
docker pull propr/agent-gemini:latest
```

Source: https://github.com/integry/propr
