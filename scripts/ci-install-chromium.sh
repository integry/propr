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

# Tests point this at a scratch copy of /etc/apt.
APT_ETC="${PROPR_CI_APT_ETC:-/etc/apt}"

# A hosted runner's apt mirror can stop answering mid-update, and apt then
# waits on it for an hour. Playwright runs apt-get as root through sudo, which
# drops APT_CONFIG, so bound every fetch through a drop-in instead. The list of
# packages stays Playwright's own.
as_root tee "$APT_ETC/apt.conf.d/99propr-ci-network-timeouts" >/dev/null <<'APT'
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

# apt's timeouts only catch a mirror that stops sending. A mirror that keeps
# the connection open and sends slowly (seen with the hosted runners' regional
# EC2 mirror) holds up a whole attempt, and a retry against it stalls the same
# way. Hosted Ubuntu images list their mirrors in a `mirror+file:` list. apt
# prefers the lowest `priority:`, puts an entry without one last, and breaks
# ties with a per-machine seed, so the same mirror wins every time. Before the
# retry, every mirror apt currently prefers moves behind the others. The retry
# then fetches from a different source, and the slow mirror is only a last
# resort. When every listed mirror is tied (or there is only one), any of them
# may have been the slow one, so the first fallback below that is not listed
# goes first: archive.ubuntu.com, or security.ubuntu.com (which the hosted
# images also list as a full mirror) when archive.ubuntu.com is listed.
FALLBACK_MIRRORS="http://archive.ubuntu.com/ubuntu/ http://security.ubuntu.com/ubuntu/"

# Prints the rewritten list, then one "demoted <uri>" line per moved mirror on
# file descriptor 3, or "unresolved" when every fallback is already a tied
# entry and the retry may reuse the slow mirror.
rewrite_mirror_list() {
  awk -v fallbacks="$FALLBACK_MIRRORS" '
    function bare(uri) { sub(/^[a-z+]+:\/\//, "", uri); sub(/\/+$/, "", uri); return uri }
    BEGIN { nf = split(fallbacks, fallback, " ") }
    /^[[:space:]]*(#|$)/ { comments = comments $0 "\n"; next }
    {
      n++; uri[n] = $1; tags[n] = ""; prio[n] = -1
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^priority:[0-9]+$/) prio[n] = substr($i, 10) + 0
        else tags[n] = tags[n] "\t" $i
      }
      for (f = 1; f <= nf; f++) if (bare($1) == bare(fallback[f])) listed[f] = 1
    }
    END {
      if (n == 0) exit 3
      best = -1
      for (i = 1; i <= n; i++) if (prio[i] >= 0 && (best < 0 || prio[i] < best)) best = prio[i]
      # apt tries the lowest explicit priority first, or any entry when none
      # has a priority.
      k = 0
      for (i = 1; i <= n; i++) {
        demoted[i] = (best < 0 || prio[i] == best)
        if (!demoted[i]) kept[++k] = i
      }
      # The others keep the order apt already uses: priority, then line.
      for (i = 2; i <= k; i++) for (j = i; j > 1; j--) {
        a = kept[j - 1]; b = kept[j]
        pa = prio[a] < 0 ? 1e18 : prio[a]; pb = prio[b] < 0 ? 1e18 : prio[b]
        if (pb >= pa) break
        kept[j - 1] = b; kept[j] = a
      }
      printf "%s", comments
      p = 1
      # Every entry is one apt may have used, so none of them is known to be a
      # different source: an unlisted fallback goes first.
      if (k == 0) {
        for (f = 1; f <= nf && listed[f]; f++);
        if (f <= nf) printf "%s\tpriority:%d\n", fallback[f], p++
        else print "unresolved" > "/dev/fd/3"
      }
      for (i = 1; i <= k; i++) printf "%s%s\tpriority:%d\n", uri[kept[i]], tags[kept[i]], p++
      for (i = 1; i <= n; i++) if (demoted[i]) {
        printf "%s%s\tpriority:%d\n", uri[i], tags[i], p++
        printf "demoted %s\n", uri[i] > "/dev/fd/3"
      }
    }
  ' "$1"
}

demote_preferred_mirrors() {
  local lists list rewritten demoted
  # Every mirror list a source refers to, one-line or deb822.
  lists=$(cat "$APT_ETC/sources.list" "$APT_ETC"/sources.list.d/*.list "$APT_ETC"/sources.list.d/*.sources 2>/dev/null \
    | grep -oE 'mirror\+file:[^[:space:]]+' | sed 's/^mirror+file://' | sort -u || true)
  if [[ -z "$lists" ]]; then
    echo "::warning::No apt mirror list is configured; the retry uses the same apt sources."
    return 0
  fi
  while IFS= read -r list; do
    demoted=$(mktemp)
    if ! rewritten=$(rewrite_mirror_list "$list" 3>"$demoted"); then
      echo "::warning::Could not read apt mirror list $list; the retry uses it unchanged."
      rm -f "$demoted"
      continue
    fi
    if ! printf '%s\n' "$rewritten" | as_root tee "$list" >/dev/null; then
      echo "::warning::Could not rewrite apt mirror list $list; the retry uses it unchanged."
      rm -f "$demoted"
      continue
    fi
    while read -r kind uri; do
      if [[ "$kind" == unresolved ]]; then
        echo "::warning::Every mirror in $list is tied with the fallbacks; the retry may reuse the slow mirror."
      else
        echo "::warning::The retry fetches from other apt mirrors before $uri (from $list)."
      fi
    done <"$demoted"
    rm -f "$demoted"
  done <<<"$lists"
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
    demote_preferred_mirrors
  fi
done
echo "::error::Chromium install timed out on every attempt."
exit 1
