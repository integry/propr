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
 *     Fly volume, loop-mounted before dockerd starts. The image survives
 *     restarts, so pulled agent images are not downloaded again.
 *  2. After an unclean stop the root filesystem can keep dockerd/containerd
 *     PID files and sockets (/var/run/docker*, /run/containerd). dockerd then
 *     refuses to start ("pid file found, ensure docker is not running"), so
 *     they are removed before it starts.
 *
 * Agent containers bind-mount worktrees and egress sockets by path, and the
 * daemon resolves those paths in ITS filesystem. Both containers therefore
 * mount one shared scratch volume at the same path, and the worker's clone,
 * worktree and egress directories are moved there.
 */

import { Buffer } from "node:buffer";
import type { JsonObject } from "./flyMachineConfig.js";

export const LEGACY_DOCKER_IMAGE = "docker:27-dind";
export const LEGACY_DOCKER_SHARED_VOLUME = "propr_shared";
export const LEGACY_DOCKER_SHARED_DIR = "/propr-shared";
export const LEGACY_DOCKER_BOOT_SCRIPT_PATH = "/usr/local/bin/propr-dockerd-boot";
export const LEGACY_DOCKER_DISK_IMAGE = "/usr/src/app/data/docker.ext4";
export const LEGACY_DOCKER_MIN_VOLUME_GB = 10;
export const LEGACY_DOCKER_MIN_MEMORY_MB = 2048;

/** App-container env pointing the worker at the in-Machine daemon and the shared directory. */
export const LEGACY_DOCKER_SHARED_ENV = {
  DOCKER_HOST: "tcp://127.0.0.1:2375",
  GIT_CLONES_BASE_PATH: `${LEGACY_DOCKER_SHARED_DIR}/git-processor/clones`,
  GIT_WORKTREES_BASE_PATH: `${LEGACY_DOCKER_SHARED_DIR}/git-processor/worktrees`,
  PROPR_EGRESS_SOCKET_DIR: `${LEGACY_DOCKER_SHARED_DIR}/egress`,
  HOST_PROPR_EGRESS_SOCKET_DIR: `${LEGACY_DOCKER_SHARED_DIR}/egress`,
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

/** Size of the ext4 image: the volume minus 2 GB headroom for SQLite and Redis. */
export function legacyDockerDiskSizeGb(volumeSizeGb: number): number {
  return Math.max(4, volumeSizeGb - 2);
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
 * The disk steps of the boot script, operating on "$IMG" and "$DOCKER_ROOT".
 * Kept separate so tests can run them against a scratch image.
 *
 * A first boot creates the image at the requested size. Later boots grow an
 * existing image that is smaller than requested (a redeploy with a larger
 * --volume-size): the sparse file is extended, never truncated below its
 * current size, then the ext4 filesystem is resized offline into it, which
 * keeps every pulled image. Growth is decided from the filesystem's own size,
 * not from whether this boot extended the file, so a resize interrupted by a
 * stop finishes on the next boot.
 */
export function renderLegacyDockerDiskSteps(diskSizeGb: number): string[] {
  assertDiskSize(diskSizeGb);
  return [
    "mkdir -p \"$DOCKER_ROOT\" \"$(dirname \"$IMG\")\"",
    "if ! mountpoint -q \"$DOCKER_ROOT\"; then",
    "  if [ ! -f \"$IMG\" ]; then",
    `    truncate -s ${diskSizeGb}G "$IMG"`,
    "    mkfs.ext4 -q -F \"$IMG\"",
    "  fi",
    "  # Repair after a hard stop; exit codes 1-2 mean errors were corrected.",
    "  e2fsck -p \"$IMG\" || [ $? -le 2 ]",
    "  # Grow, never shrink, an image made for a smaller volume.",
    `  WANT_BYTES=$((${diskSizeGb} * 1073741824))`,
    "  if [ \"$(stat -c %s \"$IMG\")\" -lt \"$WANT_BYTES\" ]; then",
    "    truncate -s \"$WANT_BYTES\" \"$IMG\"",
    "  fi",
    "  FILE_BYTES=$(stat -c %s \"$IMG\")",
    "  FS_BYTES=$(dumpe2fs -h \"$IMG\" 2>/dev/null | awk -F: '/^Block count:/ {c=$2} /^Block size:/ {s=$2} END {printf \"%.0f\", c*s}')",
    `  if [ "$FS_BYTES" -lt $((FILE_BYTES - ${LEGACY_DOCKER_RESIZE_SLACK_BYTES})) ]; then`,
    "    # resize2fs refuses an image that has not just passed a forced check.",
    "    e2fsck -f -p \"$IMG\" || [ $? -le 2 ]",
    "    resize2fs \"$IMG\"",
    "  fi",
    "  mount -o loop \"$IMG\" \"$DOCKER_ROOT\"",
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
    "",
    "# Fix 2: remove PID files and sockets left by an unclean stop, or dockerd",
    "# refuses to start because it believes another daemon is running.",
    `rm -rf ${LEGACY_DOCKER_STALE_RUNTIME_PATHS.join(" ")}`,
    "",
    "# Fix 1: overlay2 needs a real filesystem under /var/lib/docker, not the",
    "# Machine's overlay root. Keep an ext4 image on the Fly volume and loop-mount it.",
    `IMG=${LEGACY_DOCKER_DISK_IMAGE}`,
    `DOCKER_ROOT=${LEGACY_DOCKER_DATA_ROOT}`,
    ...renderLegacyDockerDiskSteps(diskSizeGb),
    "",
    `mkdir -p ${LEGACY_DOCKER_SHARED_ENV.GIT_CLONES_BASE_PATH} ${LEGACY_DOCKER_SHARED_ENV.GIT_WORKTREES_BASE_PATH} ${LEGACY_DOCKER_SHARED_ENV.PROPR_EGRESS_SOCKET_DIR}`,
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
    mounts: [{ name: LEGACY_DOCKER_SHARED_VOLUME, path: LEGACY_DOCKER_SHARED_DIR }],
    healthchecks: [{ name: "dockerd", exec: { command: ["docker", "-H", "tcp://127.0.0.1:2375", "info"] }, interval: 10, timeout: 10, grace_period: 30 }],
    restart: { policy: "always" },
  };
}
