# Log assertions shared by the image smoke harnesses.

# container_logs_contain CONTAINER TEXT
# Captures the complete log before matching.  `docker logs | grep -q` is a
# false negative under `set -o pipefail`: grep exits at the first match, the
# still-writing docker process is killed by SIGPIPE, and the pipeline fails.
# A log that cannot be read at all is reported as not containing TEXT.
container_logs_contain() {
  local logs
  logs="$(docker logs "$1" 2>&1)" || return 1
  grep -Fq -- "$2" <<< "$logs"
}
