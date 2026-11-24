# ProPR App

Backend service image for ProPR. The same image is used for the daemon, worker,
analysis worker, indexing worker, and API roles; the command passed at runtime
selects the process to run. `node dist/src/allInOne.js` runs the daemon, worker
and API (which then also serves the bundled Web UI) in one process for small hosts.

Most users should start ProPR with `propr/launcher`, which orchestrates this image
as part of the full stack.

```bash
docker pull propr/app:latest
```

Source: https://github.com/integry/propr
