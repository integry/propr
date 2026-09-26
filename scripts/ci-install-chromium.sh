#!/usr/bin/env bash

set -euo pipefail

# GitHub-hosted runners are disposable, so Playwright may apt-install the
# browser's system libraries there. The self-hosted runner is a shared host:
# only the browser itself is downloaded (into the job's
# PLAYWRIGHT_BROWSERS_PATH), and missing system libraries make the browser
# tests fail instead of changing the host's packages.
if [[ "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]]; then
  exec npx playwright install --with-deps chromium
fi
exec npx playwright install chromium
