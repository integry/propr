# ProPR App

Backend service image for ProPR. The same image is used for the daemon, worker,
analysis worker, indexing worker, and API roles; the command passed at runtime
selects the process to run.

Most users should start ProPR with `propr/launcher`, which orchestrates this image
as part of the full stack.

```bash
docker pull propr/app:latest
```

Source: https://github.com/integry/propr
