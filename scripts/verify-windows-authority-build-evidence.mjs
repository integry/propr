#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

if (process.platform !== "win32") {
  process.stderr.write("Windows authority build evidence requires Windows.\n");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages", "cli");
const script = join(cli, "scripts", "build-windows-authority-helper.mjs");
const outputDirectory = join(cli, "native", "prebuilds", "win32-anycpu");
const finals = [
  join(outputDirectory, "connect-authority-supervisor.exe"),
  join(outputDirectory, "connect-authority-supervisor.manifest.json"),
  join(outputDirectory, "connect-authority-supervisor.manifest.sig"),
  join(cli, "native", "prebuilds", "win32-x64", "connect-authority-broker.exe"),
  join(root, "scripts", "fixtures", "windows-connect-docker-fixture.exe"),
];

const completed = [];
for (const [stage, diagnostic] of [["BUILD_COMPILER", 6], ["BUILD_SOURCE", 6], ["BUILD_OUTPUT", 0]]) {
  const result = spawnSync(process.execPath, [script, "--validation", `--evidence-stage=${stage}`], {
    cwd: cli,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024,
    env: {},
  });
  assert.equal(result.error, undefined, `${stage} evidence process did not terminate cleanly`);
  assert.equal(result.signal, null, `${stage} evidence process leaked past its deadline`);
  assert.notEqual(result.status, 0, `${stage} evidence unexpectedly published a build`);
  assert.equal(result.stdout, "", `${stage} evidence emitted non-fixed stdout`);
  assert.equal(result.stderr, `[win-authority-stage:${stage}:${diagnostic}]\n`);
  assert.equal(finals.some(existsSync), false, `${stage} evidence left a published artifact`);
  const residue = existsSync(outputDirectory)
    ? readdirSync(outputDirectory).filter((name) => name.startsWith(".propr-build-"))
    : [];
  assert.deepEqual(residue, [], `${stage} evidence left a protected staging workspace`);
  completed.push({ stage, diagnostic, publishedArtifacts: 0, stagingResidue: 0, childTerminated: true });
}

const receiptArgument = process.argv.find((item) => item.startsWith("--receipt="));
if (receiptArgument) {
  const receipt = receiptArgument.slice("--receipt=".length);
  assert.equal(isAbsolute(receipt), true, "build evidence receipt path must be absolute");
  writeFileSync(receipt, `${JSON.stringify({ version: 1, stages: completed })}\n`, { flag: "wx", mode: 0o600 });
}
process.stdout.write("Windows authority production build evidence: stages=3 pass=3 fail=0 skipped=0\n");
