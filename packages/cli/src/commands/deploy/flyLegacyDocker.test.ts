/**
 * Legacy Docker-on-Fly boot script. Run with:
 * `npx tsx --test src/commands/deploy/flyLegacyDocker.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  buildLegacyDockerContainer,
  LEGACY_DOCKER_BOOT_SCRIPT_PATH,
  LEGACY_DOCKER_STALE_RUNTIME_PATHS,
  legacyDockerDiskSizeGb,
  renderLegacyDockerBootScript,
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
  assert.match(script, /mount -o loop "\$IMG" \/var\/lib\/docker/);
  assert.match(script, /if ! mountpoint -q \/var\/lib\/docker; then/);
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
