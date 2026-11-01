#!/usr/bin/env bash

set -euo pipefail

# GitHub-hosted runners are disposable, so Playwright may apt-install the
# browser's system libraries there. The self-hosted runner is a shared host:
# only the browser itself is downloaded (into the job's
# PLAYWRIGHT_BROWSERS_PATH), and missing system libraries make the browser
# tests fail instead of changing the host's packages.
if [[ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  exec npx playwright install chromium
fi

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo -n -- "$@"
  fi
}

# A hosted runner's apt mirror can stop answering mid-update, and apt then
# waits on it for an hour. Playwright runs apt-get as root through sudo, which
# drops APT_CONFIG, so bound every fetch through a drop-in instead. The list of
# packages stays Playwright's own.
as_root tee /etc/apt/apt.conf.d/99propr-ci-network-timeouts >/dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT

# A timed-out attempt can leave root apt-get or dpkg behind, holding the apt
# locks. Stop them and finish any interrupted configuration before the retry.
stop_apt() {
  as_root pkill -TERM -x apt-get || true
  as_root pkill -TERM -x dpkg || true
  sleep 5
  as_root pkill -KILL -x apt-get || true
  as_root pkill -KILL -x dpkg || true
  as_root timeout 60s dpkg --configure -a || true
}

# Retry only a timed-out install; any other failure ends the step with its own
# status, so a broken install never lets the browser tests be skipped.
for attempt in 1 2; do
  if timeout --kill-after=15s 3m npx playwright install --with-deps chromium; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -ne 124 && "$status" -ne 137 ]]; then
    exit "$status"
  fi
  echo "::warning::Chromium install attempt $attempt timed out (exit $status)."
  if [[ "$attempt" -eq 1 ]]; then
    stop_apt
  fi
done
echo "::error::Chromium install timed out on every attempt."
exit 1
