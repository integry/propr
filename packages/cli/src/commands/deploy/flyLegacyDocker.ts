/**
 * Legacy mode for `propr deploy fly --legacy-docker`: run a Docker daemon in
 * the control-plane Machine so the existing Docker agent runtime works
 * unchanged. The default deployment does NOT do this — agents run on Sprites
 * or Fly Machines and the control plane needs no Docker at all.
 *
 * Two fixes learned from running dockerd on Fly Machines are applied on every
 * boot by {@link renderLegacyDockerBootScript}:
 *
 *  1. overlay2 cannot use the Machine's root filesystem (itself an overlay) as
 *     its backing store, so /var/lib/docker is an ext4 filesystem image on the
 *     Machine's PERSISTENT root filesystem (`rootfs.persist: "always"`), loop-mounted
 *     before dockerd starts. The image survives restarts, so pulled agent
 *     images are not downloaded again. It is not on the Fly volume: the Free
 *     plan caps volumes at 5 GB, while the rootfs size is not under that cap,
 *     so the volume stays small and holds only SQLite and Redis.
 *  2. After an unclean stop the root filesystem can keep dockerd/containerd
 *     PID files and sockets (/var/run/docker*, /run/containerd). dockerd then
 *     refuses to start ("pid file found, ensure docker is not running"), so
 *     they are removed before it starts.
 *
 * Agent containers bind-mount worktrees and egress sockets by path, and the
 * daemon resolves those paths in ITS filesystem. The worker's clone, worktree
 * and egress directories therefore live in {@link LEGACY_DOCKER_SHARED_DIR} on
 * the Fly volume: the Machine-level volume mount appears at the same path in
 * every container (Redis already relies on that for its append-only file).
 * A Machine `volumes` entry with `temp_dir`, mounted per container, does NOT
 * work here: on a live Fly Machine with a persistent rootfs the docker
 * container failed on every start with
 * `cannot stat /upper/dev/vdb/propr_shared: No such file or directory`.
 */

import { Buffer } from "node:buffer";
import type { JsonObject } from "./flyMachineConfig.js";

export const LEGACY_DOCKER_IMAGE = "docker:27-dind";
/**
 * Shared by the app and docker containers: a directory on the Fly volume,
 * which is mounted at FLY_DATA_PATH (/usr/src/app/data) in every container of
 * the Machine. Spelled out rather than imported, because flyMachineConfig.ts
 * imports this module.
 */
export const LEGACY_DOCKER_VOLUME_PATH = "/usr/src/app/data";
export const LEGACY_DOCKER_SHARED_DIR = `${LEGACY_DOCKER_VOLUME_PATH}/propr-shared`;
export const LEGACY_DOCKER_BOOT_SCRIPT_PATH = "/usr/local/bin/propr-dockerd-boot";
/** On the persistent root filesystem, outside the Fly volume. */
export const LEGACY_DOCKER_DISK_IMAGE = "/var/lib/propr-docker/docker.ext4";
/** Where earlier releases kept the image: on the Fly volume, removed on boot to free it for SQLite and Redis. */
export const LEGACY_DOCKER_VOLUME_DISK_IMAGE = `${LEGACY_DOCKER_VOLUME_PATH}/docker.ext4`;
/**
 * dockerd on overlay2 next to the app and Redis ran on a 1 GB shared-cpu-1x
 * Machine (the Free plan's size); 512 MB did not. Agent containers need more,
 * so the default is 2 GB.
 */
export const LEGACY_DOCKER_MIN_MEMORY_MB = 1024;
export const LEGACY_DOCKER_DEFAULT_MEMORY_MB = 2048;
/** Persistent root filesystem for legacy mode (`rootfs.size_gb`), holding the Docker image store. */
export const LEGACY_DOCKER_DEFAULT_ROOTFS_GB = 20;
export const LEGACY_DOCKER_MIN_ROOTFS_GB = 10;
/** Room left on the rootfs for the container images of the Machine itself (app, redis, docker:dind, cloudflared). */
export const LEGACY_DOCKER_ROOTFS_HEADROOM_GB = 4;
/** Fly bills a stopped Machine's persistent root filesystem per GB-month. */
export const FLY_ROOTFS_PRICE_PER_GB_MONTH = 0.15;

/** App-container env pointing the worker at the in-Machine daemon and the shared directory. */
export const LEGACY_DOCKER_SHARED_ENV = {
  DOCKER_HOST: "tcp://127.0.0.1:2375",
  GIT_CLONES_BASE_PATH: `${LEGACY_DOCKER_SHARED_DIR}/git-processor/clones`,
  GIT_WORKTREES_BASE_PATH: `${LEGACY_DOCKER_SHARED_DIR}/git-processor/worktrees`,
  PROPR_EGRESS_SOCKET_DIR: `${LEGACY_DOCKER_SHARED_DIR}/egress`,
  HOST_PROPR_EGRESS_SOCKET_DIR: `${LEGACY_DOCKER_SHARED_DIR}/egress`,
  // The app container starts without waiting for the docker container (so a
  // waking request is answered), and the worker waits this long for the Docker
  // API before preparing agent images (src/workerDockerReadiness.ts).
  PROPR_DOCKER_STARTUP_WAIT_SECONDS: "300",
} as const;

/** Paths a previous, uncleanly stopped dockerd/containerd can leave behind. */
export const LEGACY_DOCKER_STALE_RUNTIME_PATHS = [
  "/var/run/docker.pid",
  "/var/run/docker.sock",
  "/var/run/docker",
  "/run/docker.pid",
  "/run/docker.sock",
  "/run/docker",
  "/var/run/containerd",
  "/run/containerd",
] as const;

/** Size of the ext4 image: the persistent rootfs minus headroom for the Machine's own container images. */
export function legacyDockerDiskSizeGb(rootfsSizeGb: number): number {
  return Math.max(4, rootfsSizeGb - LEGACY_DOCKER_ROOTFS_HEADROOM_GB);
}

/** What a stopped Machine's persistent rootfs costs per month, e.g. "$3.00". */
export function flyRootfsMonthlyCost(rootfsSizeGb: number): string {
  return `$${(rootfsSizeGb * FLY_ROOTFS_PRICE_PER_GB_MONTH).toFixed(2)}`;
}

export const LEGACY_DOCKER_DATA_ROOT = "/var/lib/docker";

/**
 * Below this many bytes of slack between the image file and its filesystem
 * the image counts as fully grown. Images are whole GiB (whole ext4 block
 * groups), so any real growth is far larger.
 */
const LEGACY_DOCKER_RESIZE_SLACK_BYTES = 64 * 1024 * 1024;

function assertDiskSize(diskSizeGb: number): void {
  if (!Number.isInteger(diskSizeGb) || diskSizeGb < 1) {
    throw new Error(`legacy Docker disk size must be a positive whole number of GB (got ${diskSizeGb})`);
  }
}

/**
 * Timestamped progress lines for the boot script: each names the step that
 * just finished, how long it took, and the Machine's uptime (from
 * /proc/uptime, so it lines up with "Machine started" in the Fly logs). A
 * slow wake can then be split into time before the script started, each disk
 * step, and dockerd's own startup (its "API listen" line follows the last one).
 */
export function renderLegacyDockerBootLogHelpers(): string[] {
  return [
    "boot_uptime() { cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0; }",
    "BOOT_LAST=$(boot_uptime)",
    "boot_log() {",
    "  BOOT_NOW=$(boot_uptime)",
    "  echo \"propr-dockerd-boot: $1 (+$(awk -v a=\"$BOOT_NOW\" -v b=\"$BOOT_LAST\" 'BEGIN {printf \"%.2f\", a - b}')s, machine uptime ${BOOT_NOW}s)\" >&2",
    "  BOOT_LAST=$BOOT_NOW",
    "}",
  ];
}

/**
 * Reads the image superblock once and prints "<filesystem bytes> <verdict>".
 * The verdict is "clean" only when no check e2fsck -p would make is due: the
 * filesystem was cleanly unmounted (state flag), its journal needs no
 * recovery, and neither a mount-count nor a periodic check is configured to
 * fall due. Anything else names why the boot runs e2fsck.
 */
const LEGACY_DOCKER_SUPERBLOCK_AWK = [
  "function v(x) { gsub(/^[ \\t]+|[ \\t]+$/, \"\", x); return x }",
  "/^Filesystem state:/ {state = v($2)}",
  "/^Filesystem features:/ {feat = \" \" v($2) \" \"}",
  "/^Block count:/ {c = v($2)}",
  "/^Block size:/ {s = v($2)}",
  "/^Mount count:/ {mc = v($2)}",
  "/^Maximum mount count:/ {mx = v($2)}",
  "/^Check interval:/ {ci = v($2)}",
  "END { r = \"clean\";",
  "if (state != \"clean\") { r = \"state:\" (state == \"\" ? \"unreadable\" : state); gsub(/ /, \"_\", r) }",
  "else if (feat ~ / needs_recovery /) r = \"journal-needs-recovery\";",
  "else if (mx + 0 > 0 && mc + 0 >= mx + 0) r = \"mount-count-check-due\";",
  "else if (ci + 0 > 0) r = \"periodic-check-configured\";",
  "printf \"%.0f %s\", c * s, r }",
].join(" ");

/**
 * The disk steps of the boot script, operating on "$IMG" and "$DOCKER_ROOT"
 * (and the `boot_log` helper from {@link renderLegacyDockerBootLogHelpers}).
 * Kept separate so tests can run them against a scratch image.
 *
 * A first boot creates the image at the requested size. Later boots grow an
 * existing image that is smaller than requested (a redeploy with a larger
 * --rootfs-size): the sparse file is extended, never truncated below its
 * current size, then the ext4 filesystem is resized offline into it, which
 * keeps every pulled image. Growth is decided from the filesystem's own size,
 * not from whether this boot extended the file, so a resize interrupted by a
 * stop finishes on the next boot.
 *
 * Fast path (the common wake from an idle stop): when the superblock says the
 * filesystem was cleanly unmounted, needs no journal recovery or scheduled
 * check, and already fills the image, e2fsck and resize2fs are skipped and the
 * image is mounted straight away. Any other state takes the repair path.
 */
export function renderLegacyDockerDiskSteps(diskSizeGb: number): string[] {
  assertDiskSize(diskSizeGb);
  return [
    "mkdir -p \"$DOCKER_ROOT\" \"$(dirname \"$IMG\")\"",
    "if ! mountpoint -q \"$DOCKER_ROOT\"; then",
    "  if [ ! -f \"$IMG\" ]; then",
    `    truncate -s ${diskSizeGb}G "$IMG"`,
    "    mkfs.ext4 -q -F \"$IMG\"",
    `    boot_log "created a ${diskSizeGb} GB ext4 image"`,
    "  fi",
    "  # Grow, never shrink, an image made for a smaller volume.",
    `  WANT_BYTES=$((${diskSizeGb} * 1073741824))`,
    "  if [ \"$(stat -c %s \"$IMG\")\" -lt \"$WANT_BYTES\" ]; then",
    "    truncate -s \"$WANT_BYTES\" \"$IMG\"",
    "  fi",
    "  FILE_BYTES=$(stat -c %s \"$IMG\")",
    `  MIN_FS_BYTES=$((FILE_BYTES - ${LEGACY_DOCKER_RESIZE_SLACK_BYTES}))`,
    `  FS_INFO=$(dumpe2fs -h "$IMG" 2>/dev/null | awk -F: '${LEGACY_DOCKER_SUPERBLOCK_AWK}')`,
    "  FS_BYTES=${FS_INFO%% *}",
    "  FS_VERDICT=${FS_INFO#* }",
    "  boot_log \"read the image superblock ($FS_VERDICT)\"",
    "  if [ \"$FS_VERDICT\" = clean ] && [ \"$FS_BYTES\" -ge \"$MIN_FS_BYTES\" ]; then",
    "    boot_log \"image cleanly unmounted at full size; skipping e2fsck and resize2fs\"",
    "  else",
    "    # Repair after a hard stop; exit codes 1-2 mean errors were corrected.",
    "    e2fsck -p \"$IMG\" || [ $? -le 2 ]",
    "    boot_log \"e2fsck -p\"",
    "    if [ \"$FS_BYTES\" -lt \"$MIN_FS_BYTES\" ]; then",
    "      # resize2fs refuses an image that has not just passed a forced check.",
    "      e2fsck -f -p \"$IMG\" || [ $? -le 2 ]",
    "      boot_log \"e2fsck -f -p before resize\"",
    "      resize2fs \"$IMG\"",
    "      boot_log \"resize2fs to $FILE_BYTES bytes\"",
    "    fi",
    "  fi",
    "  mount -o loop \"$IMG\" \"$DOCKER_ROOT\"",
    "  boot_log \"mounted the image at $DOCKER_ROOT\"",
    "fi",
  ];
}

/**
 * Boot script for the docker container. POSIX sh (busybox in docker:dind);
 * every step is idempotent, so a restart re-runs it safely.
 */
export function renderLegacyDockerBootScript(diskSizeGb: number): string {
  assertDiskSize(diskSizeGb);
  return [
    "#!/bin/sh",
    "# Generated by `propr deploy fly --legacy-docker`.",
    "set -eu",
    ...renderLegacyDockerBootLogHelpers(),
    "boot_log \"boot script started\"",
    "",
    "# Fix 2: remove PID files and sockets left by an unclean stop, or dockerd",
    "# refuses to start because it believes another daemon is running.",
    `rm -rf ${LEGACY_DOCKER_STALE_RUNTIME_PATHS.join(" ")}`,
    "",
    "# The directory shared with the app container is on the Fly volume. Without",
    "# the volume here, mkdir would create it on this container's own root",
    "# filesystem and agent bind mounts would silently point at empty directories.",
    `if ! mountpoint -q ${LEGACY_DOCKER_VOLUME_PATH}; then`,
    `  echo "propr-dockerd-boot: the Fly volume is not mounted at ${LEGACY_DOCKER_VOLUME_PATH} in the docker container" >&2`,
    "  exit 1",
    "fi",
    "",
    "# Earlier releases kept the image on the Fly volume; free that space for SQLite and Redis.",
    `rm -f ${LEGACY_DOCKER_VOLUME_DISK_IMAGE}`,
    "",
    "# Fix 1: overlay2 needs a real filesystem under /var/lib/docker, not the",
    "# Machine's overlay root. Keep an ext4 image on the persistent root filesystem",
    "# (rootfs.persist \"always\") and loop-mount it.",
    `IMG=${LEGACY_DOCKER_DISK_IMAGE}`,
    `DOCKER_ROOT=${LEGACY_DOCKER_DATA_ROOT}`,
    ...renderLegacyDockerDiskSteps(diskSizeGb),
    "",
    `mkdir -p ${LEGACY_DOCKER_SHARED_ENV.GIT_CLONES_BASE_PATH} ${LEGACY_DOCKER_SHARED_ENV.GIT_WORKTREES_BASE_PATH} ${LEGACY_DOCKER_SHARED_ENV.PROPR_EGRESS_SOCKET_DIR}`,
    "boot_log \"starting dockerd\"",
    "",
    "# Reachable only on the Machine's shared loopback, i.e. by the app container.",
    "exec dockerd --host=unix:///var/run/docker.sock --host=tcp://127.0.0.1:2375 \\",
    "  --storage-driver=overlay2 --tls=false",
    "",
  ].join("\n");
}

export function buildLegacyDockerContainer(diskSizeGb: number): JsonObject {
  const script = renderLegacyDockerBootScript(diskSizeGb);
  return {
    name: "docker",
    image: LEGACY_DOCKER_IMAGE,
    entrypoint: ["/bin/sh"],
    cmd: [LEGACY_DOCKER_BOOT_SCRIPT_PATH],
    files: [{ guest_path: LEGACY_DOCKER_BOOT_SCRIPT_PATH, raw_value: Buffer.from(script).toString("base64"), mode: 0o755 }],
    healthchecks: [{ name: "dockerd", exec: { command: ["docker", "-H", "tcp://127.0.0.1:2375", "info"] }, interval: 10, timeout: 10, grace_period: 30 }],
    restart: { policy: "always" },
  };
}
