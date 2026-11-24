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
  LEGACY_DOCKER_BOOT_SCRIPT_PATH,
  LEGACY_DOCKER_STALE_RUNTIME_PATHS,
  legacyDockerDiskSizeGb,
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
  // The image lives on the persistent Fly volume, so pulled images survive restarts.
  assert.match(script, /^IMG=\/usr\/src\/app\/data\/docker\.ext4$/m);
});

test("boot script is valid POSIX sh", () => {
  const result = spawnSync("sh", ["-n"], { input: renderLegacyDockerBootScript(8), encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
});

test("disk size leaves volume headroom and rejects nonsense", () => {
  assert.equal(legacyDockerDiskSizeGb(20), 18);
  assert.equal(legacyDockerDiskSizeGb(5), 4);
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

function runDiskSteps(dir: string, diskSizeGb: number): void {
  const prelude = [
    "set -eu",
    `IMG=${dir}/docker.ext4`,
    `DOCKER_ROOT=${dir}/root`,
    "mountpoint() { return 1; }",
    `mount() { echo "$@" > ${dir}/mounted; }`,
  ];
  const result = sh([...prelude, ...renderLegacyDockerDiskSteps(diskSizeGb)].join("\n"));
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
