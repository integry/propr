/**
 * Legacy Docker-on-Fly boot script. Run with:
 * `npx tsx --test src/commands/deploy/flyLegacyDocker.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildLegacyDockerContainer,
  flyRootfsMonthlyCost,
  LEGACY_DOCKER_BOOT_SCRIPT_PATH,
  LEGACY_DOCKER_SHARED_DIR,
  LEGACY_DOCKER_VOLUME_PATH,
  LEGACY_DOCKER_STALE_RUNTIME_PATHS,
  legacyDockerDiskSizeGb,
  renderLegacyDockerBootLogHelpers,
  renderLegacyDockerBootScript,
  renderLegacyDockerDiskSteps,
} from "./flyLegacyDocker.js";

test("boot script removes stale dockerd/containerd PID files before starting dockerd", () => {
  const script = renderLegacyDockerBootScript(18);
  const cleanup = script.indexOf("rm -rf ");
  assert.ok(cleanup > 0);
  for (const path of LEGACY_DOCKER_STALE_RUNTIME_PATHS) {
    assert.ok(script.slice(cleanup).split("\n")[0].includes(path), `cleans ${path}`);
  }
  assert.ok(LEGACY_DOCKER_STALE_RUNTIME_PATHS.includes("/var/run/docker.pid"));
  assert.ok(LEGACY_DOCKER_STALE_RUNTIME_PATHS.includes("/run/containerd"));
  assert.ok(cleanup < script.indexOf("exec dockerd"));
});

test("boot script loop-mounts an ext4 image at /var/lib/docker for overlay2", () => {
  const script = renderLegacyDockerBootScript(18);
  assert.match(script, /truncate -s 18G "\$IMG"/);
  assert.match(script, /mkfs\.ext4 -q -F "\$IMG"/);
  assert.match(script, /^DOCKER_ROOT=\/var\/lib\/docker$/m);
  assert.match(script, /mount -o loop "\$IMG" "\$DOCKER_ROOT"/);
  assert.match(script, /if ! mountpoint -q "\$DOCKER_ROOT"; then/);
  assert.ok(script.includes(renderLegacyDockerDiskSteps(18).join("\n")));
  assert.match(script, /--storage-driver=overlay2/);
  assert.match(script, /--host=tcp:\/\/127\.0\.0\.1:2375/);
  assert.ok(script.indexOf("mount -o loop") < script.indexOf("exec dockerd"));
  // The image lives on the persistent root filesystem, off the (Free-plan capped) Fly volume.
  assert.match(script, /^IMG=\/var\/lib\/propr-docker\/docker\.ext4$/m);
  // An image an earlier release left on the volume is removed before the new one is used.
  const cleanup = script.indexOf("rm -f /usr/src/app/data/docker.ext4");
  assert.ok(cleanup > 0 && cleanup < script.indexOf("mount -o loop"));
});

test("boot script refuses to start unless the Fly volume holding the shared directory is mounted", () => {
  const script = renderLegacyDockerBootScript(18);
  assert.ok(LEGACY_DOCKER_SHARED_DIR.startsWith(`${LEGACY_DOCKER_VOLUME_PATH}/`));
  const guard = script.indexOf(`if ! mountpoint -q ${LEGACY_DOCKER_VOLUME_PATH}; then`);
  assert.ok(guard > 0, "checks the volume mount");
  assert.match(script.slice(guard), /^ {2}exit 1$/m);
  // Before anything touches the volume or the shared directory is created.
  assert.ok(guard < script.indexOf(`rm -f ${LEGACY_DOCKER_VOLUME_PATH}/docker.ext4`));
  const mkdir = script.indexOf(`mkdir -p ${LEGACY_DOCKER_SHARED_DIR}/`);
  assert.ok(mkdir > guard, "creates the shared directories after the check");
  assert.ok(mkdir < script.indexOf("exec dockerd"));
});

test("boot script volume check fails without the volume and passes with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "propr-legacy-guard-"));
  try {
    const script = renderLegacyDockerBootScript(18);
    const guard = script.slice(script.indexOf("if ! mountpoint -q"), script.indexOf("fi", script.indexOf("if ! mountpoint -q")) + 2);
    const run = (mounted: boolean) => {
      writeFileSync(join(dir, "mountpoint"), `#!/bin/sh\n${mounted ? "exit 0" : "exit 1"}\n`, { mode: 0o755 });
      return spawnSync("sh", ["-c", `set -eu\n${guard}\necho ok`], {
        encoding: "utf-8", env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
    };
    const missing = run(false);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Fly volume is not mounted at \/usr\/src\/app\/data/);
    const present = run(true);
    assert.equal(present.status, 0, present.stderr);
    assert.equal(present.stdout.trim(), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boot script is valid POSIX sh", () => {
  const result = spawnSync("sh", ["-n"], { input: renderLegacyDockerBootScript(8), encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
});

test("disk size leaves rootfs headroom for the Machine's images and rejects nonsense", () => {
  assert.equal(legacyDockerDiskSizeGb(20), 16);
  assert.equal(legacyDockerDiskSizeGb(10), 6);
  assert.equal(legacyDockerDiskSizeGb(5), 4);
  assert.equal(flyRootfsMonthlyCost(20), "$3.00");
  assert.equal(flyRootfsMonthlyCost(15), "$2.25");
  assert.throws(() => renderLegacyDockerBootScript(0), /positive whole number/);
  assert.throws(() => renderLegacyDockerBootScript(1.5), /positive whole number/);
});

test("docker container runs the boot script written from the Machine config", () => {
  const container = buildLegacyDockerContainer(18);
  assert.deepEqual(container.cmd, [LEGACY_DOCKER_BOOT_SCRIPT_PATH]);
  const [file] = container.files as Array<{ guest_path: string; raw_value: string; mode: number }>;
  assert.equal(file.guest_path, LEGACY_DOCKER_BOOT_SCRIPT_PATH);
  assert.equal(file.mode, 0o755);
  assert.equal(Buffer.from(file.raw_value, "base64").toString(), renderLegacyDockerBootScript(18));
  // No per-container mount: the shared directory is on the Machine-level Fly volume.
  assert.equal(container.mounts, undefined);
});

// The disk steps run for real against scratch ext4 images: mountpoint and
// mount are stubbed (no root needed), everything else is e2fsprogs.
const GIB = 1024 ** 3;
const E2FS_PATH = `${process.env.PATH ?? ""}:/usr/sbin:/sbin`;
const E2FS_TOOLS = ["truncate", "stat", "mkfs.ext4", "e2fsck", "dumpe2fs", "resize2fs", "debugfs"];
const hasE2fsprogs = E2FS_TOOLS.every((tool) =>
  spawnSync("sh", ["-c", `command -v ${tool}`], { env: { PATH: E2FS_PATH } }).status === 0);
const e2fsSkip = hasE2fsprogs ? false : `needs ${E2FS_TOOLS.join(", ")}`;

function sh(script: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("sh", ["-c", script], { env: { PATH: E2FS_PATH }, encoding: "utf-8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs the disk steps; returns the e2fsck/resize2fs invocations and the boot log. */
function runDiskSteps(dir: string, diskSizeGb: number): { repairs: string[]; log: string } {
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  const prelude = [
    "set -eu",
    ...renderLegacyDockerBootLogHelpers(),
    `IMG=${dir}/docker.ext4`,
    `DOCKER_ROOT=${dir}/root`,
    "mountpoint() { return 1; }",
    `mount() { echo "$@" > ${dir}/mounted; }`,
    `e2fsck() { echo "e2fsck $*" >> ${calls}; command e2fsck "$@"; }`,
    `resize2fs() { echo "resize2fs $*" >> ${calls}; command resize2fs "$@"; }`,
  ];
  const result = sh([...prelude, ...renderLegacyDockerDiskSteps(diskSizeGb)].join("\n"));
  assert.equal(result.status, 0, result.stderr);
  return { repairs: readFileSync(calls, "utf-8").split("\n").filter(Boolean), log: result.stderr };
}

function debugfsWrite(img: string, request: string): void {
  const result = sh(`debugfs -w -R "${request}" ${img}`);
  assert.equal(result.status, 0, result.stderr);
}

function fsBytes(img: string): number {
  const out = sh(`dumpe2fs -h ${img} 2>/dev/null`).stdout;
  const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)$`, "m").exec(out)?.[1]);
  return field("Block count") * field("Block size");
}

function writeMarker(dir: string, img: string, content: string): void {
  writeFileSync(join(dir, "marker.src"), content);
  const result = sh(`debugfs -w -R "write ${dir}/marker.src marker" ${img}`);
  assert.equal(result.status, 0, result.stderr);
}

function readMarker(img: string): string {
  return sh(`debugfs -R "cat marker" ${img} 2>/dev/null`).stdout;
}

function withScratch(fn: (dir: string, img: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "propr-docker-disk-"));
  try {
    fn(dir, join(dir, "docker.ext4"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("first boot creates the ext4 image at the requested size and mounts it", { skip: e2fsSkip }, () => {
  withScratch((dir, img) => {
    runDiskSteps(dir, 1);
    assert.equal(statSync(img).size, GIB);
    assert.equal(fsBytes(img), GIB);
    assert.equal(readFileSync(join(dir, "mounted"), "utf-8").trim(), `-o loop ${img} ${dir}/root`);
  });
});

test("redeploy with a larger volume grows the existing image and keeps its contents", { skip: e2fsSkip }, () => {
  withScratch((dir, img) => {
    runDiskSteps(dir, 1);
    writeMarker(dir, img, "pulled agent image layers");
    rmSync(join(dir, "mounted"));

    runDiskSteps(dir, 3);
    assert.equal(statSync(img).size, 3 * GIB);
    assert.equal(fsBytes(img), 3 * GIB, "the filesystem, not just the file, has the new capacity");
    assert.equal(readMarker(img), "pulled agent image layers");
    assert.equal(sh(`e2fsck -f -n ${img}`).status, 0, "the grown filesystem is clean");
    assert.ok(readFileSync(join(dir, "mounted"), "utf-8").includes(img));
  });
});

test("a smaller requested size never shrinks an existing image", { skip: e2fsSkip }, () => {
  withScratch((dir, img) => {
    runDiskSteps(dir, 3);
    writeMarker(dir, img, "keep");
    runDiskSteps(dir, 1);
    assert.equal(statSync(img).size, 3 * GIB);
    assert.equal(fsBytes(img), 3 * GIB);
    assert.equal(readMarker(img), "keep");
  });
});

test("a growth interrupted after extending the file finishes on the next boot", { skip: e2fsSkip }, () => {
  withScratch((dir, img) => {
    runDiskSteps(dir, 1);
    writeMarker(dir, img, "keep");
    // The previous boot extended the file but stopped before resize2fs.
    assert.equal(sh(`truncate -s 2G ${img}`).status, 0);
    assert.equal(fsBytes(img), GIB);

    runDiskSteps(dir, 2);
    assert.equal(statSync(img).size, 2 * GIB);
    assert.equal(fsBytes(img), 2 * GIB);
    assert.equal(readMarker(img), "keep");
  });
});

test("a wake with a cleanly unmounted, full-size image skips e2fsck and resize2fs", { skip: e2fsSkip }, () => {
  withScratch((dir, img) => {
    runDiskSteps(dir, 1);
    writeMarker(dir, img, "keep");
    const { repairs, log } = runDiskSteps(dir, 1);
    assert.deepEqual(repairs, [], "no e2fsck or resize2fs on the fast path");
    assert.match(log, /read the image superblock \(clean\)/);
    assert.match(log, /skipping e2fsck and resize2fs/);
    assert.ok(readFileSync(join(dir, "mounted"), "utf-8").includes(img));
    assert.equal(readMarker(img), "keep");
  });
});

test("an image left not clean by a hard stop is checked before it is mounted", { skip: e2fsSkip }, () => {
  withScratch((dir, img) => {
    runDiskSteps(dir, 1);
    debugfsWrite(img, "ssv state 0");
    const { repairs, log } = runDiskSteps(dir, 1);
    assert.deepEqual(repairs, [`e2fsck -p ${img}`]);
    assert.match(log, /read the image superblock \(state:not_clean\)/);
    assert.ok(readFileSync(join(dir, "mounted"), "utf-8").includes(img));
    // The check marked it clean again, so the next wake takes the fast path.
    assert.deepEqual(runDiskSteps(dir, 1).repairs, []);
  });
});

test("a clean image whose journal needs recovery, or a due mount-count check, is not fast-pathed", { skip: e2fsSkip }, () => {
  withScratch((dir, img) => {
    runDiskSteps(dir, 1);
    debugfsWrite(img, "feature needs_recovery");
    const recovery = runDiskSteps(dir, 1);
    assert.match(recovery.log, /\(journal-needs-recovery\)/);
    assert.equal(recovery.repairs[0], `e2fsck -p ${img}`);
  });
  withScratch((dir, img) => {
    runDiskSteps(dir, 1);
    debugfsWrite(img, "ssv max_mnt_count 2");
    debugfsWrite(img, "ssv mnt_count 2");
    const due = runDiskSteps(dir, 1);
    assert.match(due.log, /\(mount-count-check-due\)/);
    assert.deepEqual(due.repairs, [`e2fsck -p ${img}`]);
  });
});

test("a clean image smaller than wanted still takes the forced check and resize", { skip: e2fsSkip }, () => {
  withScratch((dir, img) => {
    runDiskSteps(dir, 1);
    const { repairs, log } = runDiskSteps(dir, 2);
    assert.match(log, /read the image superblock \(clean\)/);
    assert.deepEqual(repairs, [`e2fsck -p ${img}`, `e2fsck -f -p ${img}`, `resize2fs ${img}`]);
    assert.equal(fsBytes(img), 2 * GIB);
    assert.match(log, /resize2fs to 2147483648 bytes/);
  });
});

test("boot script logs a timed line for each step, from script start to dockerd", () => {
  const script = renderLegacyDockerBootScript(18);
  const order = ["boot script started", "read the image superblock", "mounted the image at", "starting dockerd", "exec dockerd"];
  const positions = order.map((needle) => script.indexOf(needle));
  for (const [i, pos] of positions.entries()) assert.ok(pos > 0, `has ${order[i]}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "in boot order");
  // boot_log is defined before its first use.
  assert.ok(script.indexOf("boot_log() {") < script.indexOf("boot_log \"boot script started\""));
  // Each line carries the step duration and the Machine uptime.
  const result = sh([...renderLegacyDockerBootLogHelpers(), "boot_log \"step one\""].join("\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^propr-dockerd-boot: step one \(\+\d+\.\d{2}s, machine uptime [\d.]+s\)$/m);
});
