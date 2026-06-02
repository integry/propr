# ProPR Launcher

The launcher starts a complete self-hosted ProPR stack from prebuilt Docker images.
It uses the mounted Docker socket to pull and run the app, web UI, docs, Redis, and
agent execution containers with the image versions baked into the launcher manifest.

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $PWD/.env:/app/.env:ro \
  -e PROPR_ENV_FILE=$PWD/.env \
  -e PROPR_DATA_DIR=$PWD/data \
  -e PROPR_LOGS_DIR=$PWD/logs \
  -e PROPR_REPOS_DIR=$PWD/repos \
  -e HOST_CLAUDE_DIR=$HOME/.claude \
  -e HOST_CODEX_DIR=$HOME/.codex \
  -e HOST_GEMINI_DIR=$HOME/.gemini \
  propr/launcher:latest
```

Use this image for normal self-hosted installs. Use the source repository only if
you want to develop ProPR itself or customize the Docker build.

Source: https://github.com/integry/propr
