#!/usr/bin/env bash
# Regression smoke for the root steps agent entrypoints run after the task.
#
# ProPR starts agent containers as root (--init --user 0:0); the entrypoint
# drops to node for the task and then, still as root, copies refreshed
# credentials and the transcript back to host mounts. The task controls
# everything node owns, including /home/node/bin and /home/node/.local/bin,
# which lead PATH. Here the task (as node) plants programs named like the
# commands a post-task step might run in every directory it controls on PATH,
# plus task files replaced by symlinks. The smoke then checks that:
#   - none of the planted programs ran as root;
#   - the write-back still works (refreshed token, account file, transcript);
#   - symlinked task files are refused rather than followed;
#   - node cannot rewrite the entrypoints or the helpers they source.
# Each planted program records a root run and then runs the real command, so a
# regression fails on the record, not on a broken write-back.
#
# Usage: smoke-test-entrypoint-privileges.sh <agent-image> [work-dir]
# Called by scripts/smoke-test-images.sh; also runnable on its own.

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || -z "$1" ]]; then
  echo 'usage: smoke-test-entrypoint-privileges.sh <agent-image> [work-dir]' >&2
  exit 2
fi
AGENT_IMAGE="$1"
OWN_WORK_DIR=0
if [[ $# -eq 2 ]]; then
  WORK_DIR="$2"
  mkdir -p "$WORK_DIR"
else
  WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/propr-entrypoint-privileges.XXXXXX")"
  OWN_WORK_DIR=1
fi
WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"

# The containers leave root- and node-owned files in the work dir; remove them
# from inside the image, as root, before removing the directory itself.
cleanup() {
  local status=$?
  if (( OWN_WORK_DIR )); then
    docker run --rm --network none --user 0:0 -v "$WORK_DIR:/work" --entrypoint /bin/sh "$AGENT_IMAGE" \
      -c 'rm -rf /work/* /work/.[!.]* 2>/dev/null; true' >/dev/null 2>&1 || true
    rmdir "$WORK_DIR" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

# Runs as node inside the task. Every directory on PATH that node can write
# gets a program for each name; it appends "<name> <args>" to the evidence
# file when it runs as root, then execs the real command.
read -r -d '' PLANT <<'PLANT_SCRIPT' || true
set -eu
[ "$(id -u)" = 1000 ] || { echo "the task is not running as node" >&2; exit 90; }
planted=0
IFS=: read -r -a path_dirs <<< "$PATH"
for dir in "${path_dirs[@]}" /home/node/bin /home/node/.local/bin /home/node/workspace /tmp; do
  mkdir -p "$dir" 2>/dev/null || true
  [ -d "$dir" ] && [ -w "$dir" ] || continue
  for name in cp mv rm mkdir chmod chown find dirname timeout su-exec gosu python3 env cat ln sh bash id sleep kill node; do
    real=""
    for candidate in /usr/local/bin/$name /usr/sbin/$name /usr/bin/$name /bin/$name; do
      if [ -x "$candidate" ]; then real="$candidate"; break; fi
    done
    [ -n "$real" ] || continue
    printf '#!/bin/bash\nif [ "$EUID" = 0 ]; then printf "%%s %%s\\n" %q "$*" >> /propr-evidence/ran-as-root; fi\nexec %q "$@"\n' \
      "$name" "$real" > "$dir/$name.propr-plant"
    chmod 755 "$dir/$name.propr-plant"
    mv -f "$dir/$name.propr-plant" "$dir/$name"
    planted=$((planted + 1))
  done
done
[ "$planted" -gt 0 ] || { echo "the task could not plant any program" >&2; exit 91; }
PLANT_SCRIPT

fail() {
  echo "✗ $1"
  if [[ -n "${2:-}" && -f "$2" ]]; then cat "$2"; fi
  exit 1
}

# Fresh host-side directories, prepared and read back inside the image as
# root so node-owned files work whatever the runner's UID is.
prepare() {
  local label="$1" script="$2"
  rm -rf "${WORK_DIR:?}/$label" 2>/dev/null || docker run --rm --network none --user 0:0 -v "$WORK_DIR:/work" \
    --entrypoint /bin/rm "$AGENT_IMAGE" -rf "/work/$label"
  mkdir -p "$WORK_DIR/$label/evidence" "$WORK_DIR/$label/source" "$WORK_DIR/$label/transcript"
  docker run --rm --network none --user 0:0 -v "$WORK_DIR/$label:/work" --entrypoint /bin/bash "$AGENT_IMAGE" -c "
    set -eu
    chmod 0777 /work/evidence
    $script
  "
}

assert_no_root_runs() {
  local label="$1" log="$2"
  if [[ -s "$WORK_DIR/$label/evidence/ran-as-root" ]]; then
    echo "✗ $label post-task steps ran programs the task planted, as root:"
    cat "$WORK_DIR/$label/evidence/ran-as-root"
    cat "$log"
    exit 1
  fi
}

read_back() {
  local label="$1" script="$2"
  docker run --rm --network none --user 0:0 -v "$WORK_DIR/$label:/work:ro" --entrypoint /bin/bash "$AGENT_IMAGE" -c "$script"
}

# --- Image layout ------------------------------------------------------------
# bash reads a script as it runs it, so a node-writable entrypoint would let
# the task rewrite the root steps that follow it.
docker run --rm --network none --user node --entrypoint /bin/bash "$AGENT_IMAGE" -c '
  set -eu
  for file in /home/node/*-entrypoint.sh /opt/propr/privileged-post-task.sh /opt/propr/task-file-transfer.py /opt/propr/opencode-credentials.py /opt/propr; do
    if [ -w "$file" ] || [ "$(stat -c %u "$file")" != 0 ]; then echo "node can modify $file" >&2; exit 1; fi
  done
' || fail "entrypoints or post-task helpers are not root-owned and read-only to node"
echo "✓ entrypoints and post-task helpers are root-owned and read-only to node"

# --- Antigravity -------------------------------------------------------------
prepare antigravity '
  mkdir -p /work/source/antigravity-cli
  printf token-1 > /work/source/antigravity-cli/antigravity-oauth-token
  printf "{\"seeded\":true}" > /work/source/antigravity-cli/settings.json
  chmod 600 /work/source/antigravity-cli/antigravity-oauth-token /work/source/antigravity-cli/settings.json
  chown -R node:node /work/source
'
antigravity_log="$WORK_DIR/antigravity.log"
antigravity_status=0
docker run --rm --init --user 0:0 --security-opt no-new-privileges --network none \
  -e PROPR_EPHEMERAL_STATE=1 \
  -e PROPR_ANTIGRAVITY_SOURCE_CONFIG=/home/node/.gemini-source \
  -e PROPR_ANTIGRAVITY_TRANSCRIPT_PATH=/tmp/propr-antigravity-transcript/transcript.jsonl \
  -e "PROPR_SMOKE_PLANT=$PLANT" \
  -v "$WORK_DIR/antigravity/source:/home/node/.gemini-source:rw" \
  -v "$WORK_DIR/antigravity/transcript:/tmp/propr-antigravity-transcript:rw" \
  -v "$WORK_DIR/antigravity/evidence:/propr-evidence:rw" \
  --entrypoint /home/node/antigravity-entrypoint.sh \
  "$AGENT_IMAGE" /bin/bash -lc '
    set -eu
    printf token-2 > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
    ln -sf /etc/passwd "$HOME/.gemini/antigravity-cli/settings.json"
    logs="$HOME/.gemini/antigravity-cli/brain/smoke/.system_generated/logs"
    mkdir -p "$logs"
    printf "{\"step\":1}\n" > "$logs/transcript.jsonl"
    /bin/bash -c "$PROPR_SMOKE_PLANT"
  ' propr-antigravity >"$antigravity_log" 2>&1 </dev/null || antigravity_status=$?
[[ "$antigravity_status" == 0 ]] || fail "Antigravity entrypoint exited $antigravity_status" "$antigravity_log"
assert_no_root_runs antigravity "$antigravity_log"
antigravity_result="$(read_back antigravity '
  printf "%s|%s|%s|%s" "$(cat /work/source/antigravity-cli/antigravity-oauth-token)" \
    "$(stat -c %a /work/source/antigravity-cli/antigravity-oauth-token)" \
    "$(cat /work/source/antigravity-cli/settings.json)" \
    "$(cat /work/transcript/transcript.jsonl 2>/dev/null)"
')"
[[ "$antigravity_result" == 'token-2|600|{"seeded":true}|{"step":1}' ]] \
  || fail "Antigravity write-back is wrong (token|mode|settings|transcript = $antigravity_result)" "$antigravity_log"
grep -q 'could not sync refreshed Antigravity state file antigravity-cli/settings.json' "$antigravity_log" \
  || fail "Antigravity did not report the refused symlinked settings.json" "$antigravity_log"
echo "✓ Antigravity post-task steps run no task-planted program as root, refuse symlinks and still write back"

# --- OpenCode ----------------------------------------------------------------
prepare opencode '
  /usr/bin/python3 -I -c "
import json, sqlite3
db = sqlite3.connect(\"/work/source/opencode.db\")
db.executescript(\"\"\"
CREATE TABLE migration (id TEXT PRIMARY KEY);
CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
CREATE TABLE machine (id TEXT PRIMARY KEY);
CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT,
    method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER);
\"\"\")
value = json.dumps({\"type\": \"oauth\", \"methodID\": \"oauth\", \"refresh\": \"refresh-1\", \"access\": \"access-1\", \"expires\": 1})
db.execute(\"INSERT INTO credential VALUES (?, ?, ?, ?, NULL, ?, 1, 1, 1)\", (\"cred-openai\", \"openai\", \"ChatGPT\", value, \"oauth\"))
db.commit()
"
  printf "{\"account\":1}" > /work/source/account.json
  chmod 600 /work/source/account.json
  chown -R node:node /work/source
'
opencode_log="$WORK_DIR/opencode.log"
opencode_status=0
docker run --rm --init --user 0:0 --security-opt no-new-privileges --network none \
  -e XDG_DATA_HOME=/tmp/propr-opencode-data \
  -e PROPR_EPHEMERAL_STATE=1 \
  -e PROPR_OPENCODE_SOURCE_DATA=/home/node/.local/share/opencode-source \
  -e "PROPR_SMOKE_PLANT=$PLANT" \
  -v "$WORK_DIR/opencode/source:/home/node/.local/share/opencode-source:rw" \
  -v "$WORK_DIR/opencode/evidence:/propr-evidence:rw" \
  --entrypoint /home/node/opencode-entrypoint.sh \
  "$AGENT_IMAGE" /bin/bash -c '
    set -eu
    /usr/bin/python3 -I -c "
import json, sqlite3
db = sqlite3.connect(\"/tmp/propr-opencode-data/opencode/opencode.db\")
value = json.dumps({\"type\": \"oauth\", \"methodID\": \"oauth\", \"refresh\": \"refresh-2\", \"access\": \"access-2\", \"expires\": 2})
assert db.execute(\"UPDATE credential SET value=?, time_updated=2 WHERE id=?\", (value, \"cred-openai\")).rowcount == 1
db.commit()
"
    printf "{\"account\":2}" > /tmp/propr-opencode-data/opencode/account.json
    /bin/bash -c "$PROPR_SMOKE_PLANT"
  ' >"$opencode_log" 2>&1 </dev/null || opencode_status=$?
[[ "$opencode_status" == 0 ]] || fail "OpenCode entrypoint exited $opencode_status" "$opencode_log"
assert_no_root_runs opencode "$opencode_log"
opencode_result="$(read_back opencode '
  /usr/bin/python3 -I -c "
import json, os, sqlite3
refresh = json.loads(sqlite3.connect(\"file:/work/source/opencode.db?mode=ro\", uri=True).execute(\"SELECT value FROM credential WHERE id=?\", (\"cred-openai\",)).fetchone()[0])[\"refresh\"]
print(refresh + \"|\" + open(\"/work/source/account.json\").read() + \"|\" + oct(os.stat(\"/work/source/account.json\").st_mode & 0o777))
"
')"
[[ "$opencode_result" == 'refresh-2|{"account":2}|0o600' ]] \
  || fail "OpenCode write-back is wrong (refresh|account|mode = $opencode_result)" "$opencode_log"
echo "✓ OpenCode post-task steps run no task-planted program as root and still write back"
