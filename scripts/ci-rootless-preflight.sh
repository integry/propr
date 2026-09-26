#!/usr/bin/env bash
set -euo pipefail

# Compatibility checks, not admission control: this file is PR-editable.
# Require an explicit socket so changing HOME cannot select a different daemon.
fail() { echo "Rootless runner prerequisite: $*" >&2; exit 1; }
for executable in bash git docker curl tar gzip unzip python3 make g++ sha256sum timeout node npm; do
  command -v "$executable" >/dev/null || fail "missing $executable in the runner image"
done
[[ "${DOCKER_HOST:-}" == unix:///* ]] || fail 'set DOCKER_HOST to the worker user-scoped Unix socket'
[[ "$DOCKER_HOST" != *$'\n'* && "$DOCKER_HOST" != *$'\r'* ]] || fail 'socket endpoint must be a single line'
case "$DOCKER_HOST" in
  unix:///var/run/docker.sock|unix:///run/docker.sock) fail 'production Docker socket paths are forbidden' ;;
esac
[[ -z "${DOCKER_CONTEXT:-}" ]] || fail 'unset DOCKER_CONTEXT; use explicit DOCKER_HOST'
[[ -z "${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || fail 'unset Docker TLS settings for the local socket'
[[ -d "${GITHUB_WORKSPACE:-}" && -w "$GITHUB_WORKSPACE" ]] || fail 'workspace must exist and be writable'
[[ -d "${RUNNER_TEMP:-}" && -w "$RUNNER_TEMP" ]] || fail 'RUNNER_TEMP must exist and be writable'

# Ignore saved contexts and registry credentials, including before HOME isolation.
# This directory is runner-managed job state, not the daemon user's config.
export DOCKER_CONFIG="$RUNNER_TEMP/propr-docker-client"
mkdir -p "$DOCKER_CONFIG"
printf '{"auths":{}}\n' > "$DOCKER_CONFIG/config.json"
security="$(docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}')"
[[ "$security" == *name=rootless* ]] || fail 'Docker daemon does not report rootless mode'
cgroups="$(docker info --format '{{.CgroupVersion}}/{{.CgroupDriver}}')"
[[ "$cgroups" == '2/systemd' ]] || fail 'rootless resource limits require cgroup v2 with systemd'
# The Redis helper runs its container with --init so tini reaps the health-check
# processes the container's PID namespace reparents to PID 1. A daemon without an
# init binary would instead fail every shard's Redis start with an opaque OCI
# error, so name the missing prerequisite here.
init_binary="$(docker info --format '{{.InitBinary}}')"
[[ -n "$init_binary" ]] || fail 'rootless daemon reports no init binary; --init containers cannot start'

# The socket remains explicit after HOME and DOCKER_CONFIG move to job state.
# Only successful validation enables the always() Redis cleanup on this daemon.
{
  echo "DOCKER_HOST=$DOCKER_HOST"
  echo 'DOCKER_CONTEXT='
  echo 'PROPR_ROOTLESS_DOCKER_READY=true'
} >> "$GITHUB_ENV"
echo 'Rootless daemon compatibility checks passed; host containment, bind paths, network and effective limits still require pilot evidence.'
