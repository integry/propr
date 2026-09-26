#!/bin/bash
set -euo pipefail

if [ "$#" -ne 10 ]; then
  echo 'Installed Linux package acceptance received invalid arguments' >&2
  exit 64
fi

family="$1"
architecture="$2"
package_architecture="$3"
previous_version="$4"
version="$5"
previous_artifact="$6"
artifact="$7"
desktop_icon_sha256="$8"
tray_icon_sha256="$9"
sandbox_isolation="${10}"
package_name='propr-desktop'
test_user='propr-acceptance'
test_home="/home/$test_user"
smoke_root="$test_home/propr-desktop-smoke-installed"
xdg_cache_home="$test_home/.cache"
xdg_config_home="$test_home/.config"
xdg_data_parent="$test_home/.local"
xdg_data_home="$xdg_data_parent/share"
xdg_runtime_dir="$test_home/.runtime"
synthetic_keyring_root="$test_home/propr-desktop-smoke-keyring"
user_configuration="$xdg_config_home/propr-desktop/package-acceptance.json"
desktop_file='/usr/share/applications/propr-desktop.desktop'
launcher_icon='/usr/share/pixmaps/propr-desktop.png'
application_root='/usr/lib/propr-desktop'
executable="$application_root/propr-desktop"
sandbox="$application_root/chrome-sandbox"
runtime_icon="$application_root/resources/propr-desktop.png"
tray_icon="$application_root/resources/propr-tray.png"
native_addon="$application_root/resources/app.asar.unpacked/.vite/native/prebuilds/linux-$architecture/directory-operations.node"
owned_system_entries='/tmp/propr-package-owned-system-entries'
owned_system_directories='/tmp/propr-package-owned-system-directories'
current_phase='argument-validation'
last_completed_phase='none'
failed_phase=''
outcome='failed'
environment_limitation=''
artifact_metadata_verified=false
installed_payloads_verified=0
launches_attempted=0
launches_passed=0
upgrade_completed=false
uninstall_completed=false
user_data_preserved=false

fail() {
  if [ -z "$failed_phase" ]; then failed_phase="$current_phase"; fi
  echo "Installed Linux package acceptance failed: $1" >&2
  exit 1
}

if [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ]; then
  fail 'this script may run only inside a disposable container'
fi
if [ "$(id -u)" -ne 0 ]; then
  fail 'container package operations require root'
fi
case "$family:$architecture:$package_architecture" in
  deb:x64:amd64|deb:arm64:arm64|rpm:x64:x86_64|rpm:arm64:aarch64) ;;
  *) fail 'package family or architecture is invalid' ;;
esac
case "$sandbox_isolation" in
  docker-default|docker-cap-sys-admin) ;;
  *) fail 'sandbox isolation mode is invalid' ;;
esac
case "$(uname -m):$architecture" in
  x86_64:x64|aarch64:arm64|arm64:arm64) ;;
  *) fail 'container kernel architecture does not match the artifact; emulation is not accepted' ;;
esac
for value in "$previous_version" "$version"; do
  [[ "$value" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || fail 'package version is invalid'
done
IFS=. read -r previous_major previous_minor previous_patch <<< "$previous_version"
IFS=. read -r current_major current_minor current_patch <<< "$version"
if (( previous_major > current_major \
  || (previous_major == current_major && previous_minor > current_minor) \
  || (previous_major == current_major && previous_minor == current_minor && previous_patch >= current_patch) )); then
  fail 'package acceptance requires a strictly increasing version upgrade'
fi
for candidate in "$previous_artifact" "$artifact"; do
  [ -f "$candidate" ] && [ ! -L "$candidate" ] || fail 'mounted artifact is not a regular non-link file'
  [ -s "$candidate" ] || fail 'mounted artifact is empty'
  [ ! -w "$candidate" ] || fail 'mounted artifact is not read-only'
done

package_present() {
  if [ "$family" = deb ]; then
    dpkg-query -W -f='${db:Status-Status}' "$package_name" 2>/dev/null | grep -qx 'installed'
  else
    rpm -q "$package_name" >/dev/null 2>&1
  fi
}

remove_package() {
  if ! package_present; then return; fi
  if [ "$family" = deb ]; then
    DEBIAN_FRONTEND=noninteractive apt-get remove -y "$package_name" >/dev/null
  else
    dnf remove -y "$package_name" >/dev/null
  fi
}

emit_lifecycle_evidence() {
  local limitation_json='null'
  if [ -n "$environment_limitation" ]; then
    limitation_json="\"$environment_limitation\""
  fi
  printf 'PROPR_INSTALLED_LINUX_EVIDENCE={"schemaVersion":1,"family":"%s","architecture":"%s","sandboxIsolation":"%s","outcome":"%s","lastCompletedPhase":"%s","failedPhase":"%s","artifactMetadataVerified":%s,"installedPayloadsVerified":%s,"launchesAttempted":%s,"launchesPassed":%s,"upgradeCompleted":%s,"uninstallCompleted":%s,"userDataPreserved":%s,"environmentLimitation":%s}\n' \
    "$family" "$architecture" "$sandbox_isolation" "$outcome" "$last_completed_phase" "$failed_phase" \
    "$artifact_metadata_verified" "$installed_payloads_verified" "$launches_attempted" "$launches_passed" \
    "$upgrade_completed" "$uninstall_completed" "$user_data_preserved" "$limitation_json"
}

cleanup() {
  local exit_status="$?"
  trap - EXIT INT TERM
  set +e
  remove_package || true
  pkill -KILL -u "$test_user" 2>/dev/null || true
  userdel --remove "$test_user" >/dev/null 2>&1 || true
  if [ "$exit_status" -eq 0 ]; then
    outcome='passed'
    failed_phase=''
  elif [ -z "$failed_phase" ]; then
    failed_phase="$current_phase"
  fi
  emit_lifecycle_evidence
  if [ "$exit_status" -eq 0 ]; then
    printf '{"schemaVersion":1,"family":"%s","architecture":"%s","installProof":"package-manager-database","launches":2,"upgrade":true,"userDataPreserved":true,"ownedSystemEntriesRemoved":true}\n' \
      "$family" "$architecture"
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'failed_phase="${failed_phase:-interrupted}"; exit 130' INT
trap 'failed_phase="${failed_phase:-interrupted}"; exit 143' TERM

current_phase='prerequisites'
if [ "$family" = deb ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    binutils ca-certificates dbus-x11 gnome-keyring libsecret-1-0 procps util-linux xauth xvfb
else
  dnf install -y \
    binutils ca-certificates dbus-x11 gnome-keyring libsecret procps-ng util-linux \
    xorg-x11-server-Xvfb xorg-x11-xauth
fi
package_present && fail 'container image already contains propr-desktop'
last_completed_phase='prerequisites'

current_phase='sandbox-preflight'
namespace_preflight_log='/tmp/propr-package-namespace-preflight.log'
set +e
unshare --mount --propagation unchanged --pid --net --fork /bin/true >"$namespace_preflight_log" 2>&1
namespace_preflight_status="$?"
set -e
if [ "$namespace_preflight_status" -ne 0 ]; then
  outcome='environment-limited'
  if [ "$sandbox_isolation" = docker-default ]; then
    environment_limitation='Container runtime denied the mount, PID, and network namespaces required by the Electron sandbox under Docker default capabilities; no application launch, upgrade, or uninstall acceptance was reached. Use the explicit docker-cap-sys-admin mode on an authorized host or a disposable native VM.'
  else
    environment_limitation='Container runtime or host policy denied the mount, PID, and network namespaces required by the Electron sandbox even with the explicit SYS_ADMIN capability; no application launch, upgrade, or uninstall acceptance was reached. Use a disposable native VM.'
  fi
  head -c 4096 "$namespace_preflight_log" >&2 || true
  fail 'Electron sandbox namespace preflight is unavailable in this environment'
fi
last_completed_phase='sandbox-preflight'

metadata_field() {
  local package="$1"
  local field="$2"
  if [ "$family" = deb ]; then
    dpkg-deb --field "$package" "$field"
  else
    case "$field" in
      Package) rpm -qp --queryformat '%{NAME}' "$package" ;;
      Version) rpm -qp --queryformat '%{VERSION}' "$package" ;;
      Architecture) rpm -qp --queryformat '%{ARCH}' "$package" ;;
      Depends) rpm -qp --requires "$package" ;;
      Description) rpm -qp --queryformat '%{SUMMARY}' "$package" ;;
      Homepage) rpm -qp --queryformat '%{URL}' "$package" ;;
      License) rpm -qp --queryformat '%{LICENSE}' "$package" ;;
      *) fail 'unsupported package metadata field' ;;
    esac
  fi
}

verify_artifact_metadata() {
  local package="$1"
  local expected_version="$2"
  [ "$(metadata_field "$package" Package)" = "$package_name" ] || fail 'package name metadata is invalid'
  [ "$(metadata_field "$package" Version)" = "$expected_version" ] || fail 'package version metadata is invalid'
  [ "$(metadata_field "$package" Architecture)" = "$package_architecture" ] \
    || fail 'package architecture metadata is invalid'
  local dependencies
  dependencies="$(metadata_field "$package" Depends)"
  [ -n "$dependencies" ] || fail 'package dependency metadata is empty'
  printf '%s\n' "$dependencies" | grep -Eq '(^|[ ,])(gtk3|libgtk-3-[0-9a-z]+)([ ,]|$|[[:space:]])' \
    || fail 'package dependency metadata is missing GTK'
  printf '%s\n' "$dependencies" | grep -Eq '(^|[ ,])xdg-utils([ ,]|$|[[:space:]])' \
    || fail 'package dependency metadata is missing xdg-utils'
  [ "$(metadata_field "$package" Homepage)" = 'https://github.com/integry/propr' ] \
    || fail 'package homepage metadata is invalid'
  case "$(metadata_field "$package" Description)" in
    'Secure ProPR desktop application'*) ;;
    *) fail 'package description metadata is invalid' ;;
  esac
  if [ "$family" = rpm ]; then
    [ "$(metadata_field "$package" License)" = 'Apache-2.0' ] || fail 'package license metadata is invalid'
  fi
}

installed_version() {
  if [ "$family" = deb ]; then
    dpkg-query -W -f='${Version}' "$package_name"
  else
    rpm -q --queryformat '%{VERSION}' "$package_name"
  fi
}

installed_dependencies() {
  if [ "$family" = deb ]; then
    dpkg-query -W -f='${Depends}' "$package_name"
  else
    rpm -q --requires "$package_name"
  fi
}

install_artifact() {
  local package="$1"
  if [ "$family" = deb ]; then
    apt-get install -y "$package"
  else
    dnf install -y "$package"
  fi
}

snapshot_owned_system_entries() {
  local listing
  if [ "$family" = deb ]; then
    listing="$(dpkg-query -L "$package_name")"
  else
    listing="$(rpm -ql "$package_name")"
  fi
  : > "$owned_system_entries"
  : > "$owned_system_directories"
  while IFS= read -r path; do
    if [ -f "$path" ] || [ -L "$path" ]; then
      case "$path" in
        /usr/*) printf '%s\n' "$path" >> "$owned_system_entries" ;;
        *) fail 'package database contains an unexpected owned file path' ;;
      esac
    elif [ -d "$path" ]; then
      case "$path" in
        /usr/*propr-desktop*) printf '%s\n' "$path" >> "$owned_system_directories" ;;
      esac
    fi
  done <<< "$listing"
  [ -s "$owned_system_entries" ] || fail 'package database did not report owned system files'
}

assert_mode_owner() {
  local path="$1"
  local expected_mode="$2"
  [ -f "$path" ] && [ ! -L "$path" ] || fail 'installed package payload file is missing or linked unexpectedly'
  [ "$(stat -c '%a:%u:%g' "$path")" = "$expected_mode:0:0" ] \
    || fail 'installed package payload mode or ownership is invalid'
}

assert_installed_payload() {
  [ "$(installed_version)" = "$1" ] || fail 'installed package database version is invalid'
  [ "$(installed_dependencies)" = "$(metadata_field "$2" Depends)" ] \
    || fail 'installed package database dependency metadata differs from the artifact'
  [ "$(readlink -f /usr/bin/propr-desktop)" = "$executable" ] || fail 'installed command does not resolve to the packaged executable'
  assert_mode_owner "$executable" 755
  assert_mode_owner "$sandbox" 4755
  assert_mode_owner "$native_addon" 755
  assert_mode_owner "$desktop_file" 644
  assert_mode_owner "$launcher_icon" 644
  readelf -h "$executable" | grep -Eq "Machine:[[:space:]]+(Advanced Micro Devices X86-64|AArch64)" \
    || fail 'installed executable is not a supported ELF architecture'
  readelf -h "$native_addon" | grep -Eq "Machine:[[:space:]]+(Advanced Micro Devices X86-64|AArch64)" \
    || fail 'installed native addon is not a supported ELF architecture'
  grep -qx 'Name=ProPR Desktop' "$desktop_file" || fail 'desktop entry name is invalid'
  grep -Eq '^Exec=propr-desktop( %U)?$' "$desktop_file" || fail 'desktop entry command is invalid'
  grep -qx 'Icon=propr-desktop' "$desktop_file" || fail 'desktop entry icon is invalid'
  grep -Eq '^MimeType=.*x-scheme-handler/propr;' "$desktop_file" || fail 'desktop entry scheme handler is missing'
  echo "$desktop_icon_sha256  $launcher_icon" | sha256sum --check --status \
    || fail 'installed launcher icon does not match the verified transparent asset'
  echo "$desktop_icon_sha256  $runtime_icon" | sha256sum --check --status \
    || fail 'installed runtime icon does not match the verified transparent asset'
  echo "$tray_icon_sha256  $tray_icon" | sha256sum --check --status \
    || fail 'installed tray icon does not match the verified transparent asset'
}

run_installed_smoke() {
  local phase="$1"
  local evidence="$smoke_root/application.smoke-evidence.jsonl"
  local launch_log="/tmp/propr-package-$phase-launch.log"
  local launch_status
  launches_attempted=$((launches_attempted + 1))
  set +e
  runuser -u "$test_user" -- env -i \
    HOME="$test_home" USER="$test_user" LOGNAME="$test_user" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PATH=/usr/local/bin:/usr/bin:/bin XDG_CACHE_HOME="$xdg_cache_home" \
    XDG_CONFIG_HOME="$xdg_config_home" XDG_DATA_HOME="$synthetic_keyring_root" \
    XDG_RUNTIME_DIR="$xdg_runtime_dir" \
    PROPR_DESKTOP_SMOKE_KEYRING_ROOT="$synthetic_keyring_root" PROPR_DESKTOP_SMOKE_TEST=1 \
    timeout --signal=TERM --kill-after=10s 120s \
    dbus-run-session -- bash -euo pipefail -c '
      eval "$(printf "%s\n" "propr-installed-package-smoke" | gnome-keyring-daemon --unlock --components=secrets)"
      exec xvfb-run --auto-servernum "$1" --disable-gpu --propr-smoke-test \
        "--user-data-dir=$2" --password-store=gnome-libsecret \
        "propr://connect?api=https%3A%2F%2Fconnect.propr.dev"
    ' bash /usr/bin/propr-desktop "$smoke_root" \
    2>&1 | tee "$launch_log"
  launch_status="${PIPESTATUS[0]}"
  set -e
  if [ "$launch_status" -ne 0 ]; then
    if grep -Eq 'Failed to move to new namespace|zygote_host_impl_linux\.cc[^:]*:[0-9]+.*Zygote process exited prematurely' "$launch_log"; then
      outcome='environment-limited'
      environment_limitation='Electron reached a container namespace or seccomp boundary during a real installed-package launch; this is an execution-environment limitation, not package acceptance. Upgrade and uninstall acceptance were not reached.'
    fi
    fail "installed application launch exited $launch_status"
  fi
  [ -f "$evidence" ] && [ ! -L "$evidence" ] || fail 'installed application did not emit smoke evidence'
  for event in desktop.smoke.authorized desktop.app.ready desktop.renderer.mvp_flows.ready \
    desktop.renderer.ready desktop.app.shutdown; do
    grep -Fqx "{\"event\":\"$event\"}" "$evidence" || fail 'installed application smoke evidence is incomplete'
  done
  if grep -Eq 'desktop\.(app\.start_failed|main_process\.uncaught_exception|log\.write_failed)' "$evidence"; then
    fail 'installed application reported a smoke failure'
  fi
  mv "$evidence" "$smoke_root/application.smoke-evidence.$phase.jsonl"
  launches_passed=$((launches_passed + 1))
}

preflight_synthetic_keyring() {
  local keyring_preflight_log='/tmp/propr-package-keyring-preflight.log'
  local keyring_preflight_status
  set +e
  runuser -u "$test_user" -- env -i \
    HOME="$test_home" USER="$test_user" LOGNAME="$test_user" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PATH=/usr/local/bin:/usr/bin:/bin XDG_CONFIG_HOME="$xdg_config_home" \
    XDG_DATA_HOME="$synthetic_keyring_root" XDG_RUNTIME_DIR="$xdg_runtime_dir" \
    timeout --signal=TERM --kill-after=5s 30s \
    dbus-run-session -- bash -euo pipefail -c '
      keyring_environment="$(printf "%s\n" "propr-installed-package-smoke" | gnome-keyring-daemon --unlock --components=secrets)"
      eval "$keyring_environment"
      unset keyring_environment
      dbus-send --session --type=method_call --print-reply \
        --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.DBus.Peer.Ping >/dev/null
    ' >"$keyring_preflight_log" 2>&1
  keyring_preflight_status="$?"
  set -e
  if [ "$keyring_preflight_status" -ne 0 ]; then
    outcome='environment-limited'
    if grep -Eqi 'gnome-keyring-daemon.*Operation not permitted|org\.freedesktop\.secrets.*Operation not permitted' \
      "$keyring_preflight_log"; then
      if [ "$sandbox_isolation" = docker-default ]; then
        environment_limitation='Container runtime capability policy denied execution of the installed distribution gnome-keyring-daemon, so Secret Service was unavailable; Rocky Linux 9 requires IPC_LOCK for this file-capability binary. No application launch, upgrade, or uninstall acceptance was reached. Use the explicit docker-cap-sys-admin mode on an authorized host or a disposable native VM.'
      else
        environment_limitation='Container runtime or host policy denied execution of the installed distribution gnome-keyring-daemon even with the explicit SYS_ADMIN and IPC_LOCK capabilities, so Secret Service was unavailable. No application launch, upgrade, or uninstall acceptance was reached. Use a disposable native VM.'
      fi
    else
      environment_limitation='The installed distribution gnome-keyring-daemon did not make the synthetic Secret Service ready within 30 seconds under the selected container policy. No application launch, upgrade, or uninstall acceptance was reached. Use a disposable native VM if the container runtime blocks this service.'
    fi
    head -c 4096 "$keyring_preflight_log" >&2 || true
    fail 'synthetic Secret Service keyring preflight is unavailable in this environment'
  fi
}

current_phase='artifact-metadata'
verify_artifact_metadata "$previous_artifact" "$previous_version"
verify_artifact_metadata "$artifact" "$version"
artifact_metadata_verified=true
last_completed_phase='artifact-metadata'
useradd --create-home --home-dir "$test_home" --shell /bin/bash "$test_user"
for synthetic_directory in \
  "$xdg_cache_home" "$xdg_config_home" "$xdg_data_parent" "$xdg_data_home" \
  "$xdg_runtime_dir" "$synthetic_keyring_root" "$smoke_root" "$xdg_config_home/propr-desktop"; do
  install -d -m 700 -o "$test_user" -g "$test_user" "$synthetic_directory"
  [ "$(stat -c '%a:%U:%G' "$synthetic_directory")" = "700:$test_user:$test_user" ] \
    || fail 'synthetic user directory mode or ownership is invalid'
done

current_phase='previous-package-payload'
install_artifact "$previous_artifact"
assert_installed_payload "$previous_version" "$previous_artifact"
installed_payloads_verified=1
last_completed_phase='previous-package-payload'
current_phase='keyring-preflight'
preflight_synthetic_keyring
last_completed_phase='keyring-preflight'
current_phase='before-upgrade-launch'
run_installed_smoke before-upgrade
last_completed_phase='before-upgrade-launch'

current_phase='user-configuration'
printf '%s\n' '{"schemaVersion":1,"synthetic":"preserve-across-package-upgrade-and-removal"}' > "$user_configuration"
chown "$test_user:$test_user" "$user_configuration"
chmod 600 "$user_configuration"
configuration_sha256="$(sha256sum "$user_configuration" | cut -d ' ' -f 1)"
runuser -u "$test_user" -- env -i HOME="$test_home" PATH=/usr/bin:/bin \
  XDG_CONFIG_HOME="$xdg_config_home" XDG_DATA_HOME="$xdg_data_home" \
  xdg-mime default propr-desktop.desktop x-scheme-handler/propr
[ "$(runuser -u "$test_user" -- env -i HOME="$test_home" PATH=/usr/bin:/bin \
  XDG_CONFIG_HOME="$xdg_config_home" XDG_DATA_HOME="$xdg_data_home" \
  xdg-mime query default x-scheme-handler/propr)" = 'propr-desktop.desktop' ] \
  || fail 'installed desktop entry did not register as the synthetic user scheme handler'
last_completed_phase='user-configuration'

current_phase='upgrade-and-payload'
install_artifact "$artifact"
assert_installed_payload "$version" "$artifact"
installed_payloads_verified=2
[ "$(sha256sum "$user_configuration" | cut -d ' ' -f 1)" = "$configuration_sha256" ] \
  || fail 'package upgrade changed synthetic user configuration'
[ "$(stat -c '%a:%U:%G' "$user_configuration")" = "600:$test_user:$test_user" ] \
  || fail 'package upgrade changed synthetic user configuration authority'
upgrade_completed=true
last_completed_phase='upgrade-and-payload'
current_phase='after-upgrade-launch'
run_installed_smoke after-upgrade
last_completed_phase='after-upgrade-launch'

current_phase='uninstall'
snapshot_owned_system_entries
remove_package
package_present && fail 'package manager still reports propr-desktop installed after removal'
while IFS= read -r owned_path; do
  [ ! -e "$owned_path" ] && [ ! -L "$owned_path" ] || fail 'package removal left a database-owned system file behind'
done < "$owned_system_entries"
while IFS= read -r owned_path; do
  [ ! -e "$owned_path" ] && [ ! -L "$owned_path" ] || fail 'package removal left a package-specific system directory behind'
done < "$owned_system_directories"
for owned_path in /usr/bin/propr-desktop "$application_root" "$desktop_file" "$launcher_icon" \
  /usr/share/doc/propr-desktop /usr/share/licenses/propr-desktop; do
  [ ! -e "$owned_path" ] && [ ! -L "$owned_path" ] || fail 'package removal left an owned system entry behind'
done
[ "$(sha256sum "$user_configuration" | cut -d ' ' -f 1)" = "$configuration_sha256" ] \
  || fail 'package removal changed synthetic user configuration'
[ -f "$smoke_root/application.smoke-evidence.before-upgrade.jsonl" ] \
  && [ -f "$smoke_root/application.smoke-evidence.after-upgrade.jsonl" ] \
  || fail 'package removal deleted synthetic application user data'
uninstall_completed=true
user_data_preserved=true
last_completed_phase='uninstall'
current_phase='complete'
