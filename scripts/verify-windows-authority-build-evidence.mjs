#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  join(cli, "native", "prebuilds", "win32-service", "ProPRConnectAuthority.exe"),
  join(cli, "native", "prebuilds", "win32-service", "ProPRConnectAuthority.msi"),
  join(root, "scripts", "fixtures", "windows-connect-docker-fixture.exe"),
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const artifactSnapshot = () => finals.map((path) => {
  if (!existsSync(path)) return { path, exists: false };
  const stat = lstatSync(path, { bigint: true });
  assert.equal(stat.isFile(), true, "baseline published artifact is not an ordinary file");
  assert.equal(stat.isSymbolicLink(), false, "baseline published artifact is a link");
  return {
    path, exists: true, device: stat.dev.toString(10), file: stat.ino.toString(10),
    size: stat.size.toString(10), sha256: sha256(readFileSync(path)),
  };
});
const residueSnapshot = () => existsSync(outputDirectory)
  ? readdirSync(outputDirectory).filter((name) => name.startsWith(".propr-build-")).sort()
  : [];

async function runEvidence(stage, diagnostic) {
  const nonce = randomBytes(32).toString("hex");
  const key = randomBytes(32);
  const baseline = artifactSnapshot();
  const baselineResidue = residueSnapshot();
  const child = spawn(process.execPath, [script, "--validation", `--evidence-stage=${stage}`], {
    cwd: cli,
    shell: false,
    windowsHide: true,
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  child.stdin.end(Buffer.from(`PROPR_BUILD_EVIDENCE_V1 ${nonce} ${key.toString("hex")}\n`, "ascii"));
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let receiptBytes = Buffer.alloc(0);
  const append = (current, chunk) => {
    const next = Buffer.concat([current, Buffer.from(chunk)]);
    if (next.byteLength > 64 * 1024) child.kill("SIGKILL");
    return next;
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  child.stdio[3].on("data", (chunk) => { receiptBytes = append(receiptBytes, chunk); });
  const result = await new Promise((resolveResult, rejectResult) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 180_000);
    child.once("error", (error) => { clearTimeout(timer); rejectResult(error); });
    child.once("close", (status, signal) => { clearTimeout(timer); resolveResult({ status, signal, timedOut }); });
  });

  assert.equal(result.timedOut, false, `${stage} evidence exceeded its hard deadline`);
  assert.equal(result.signal, null, `${stage} evidence child/job did not terminate cleanly`);
  assert.notEqual(result.status, 0, `${stage} evidence unexpectedly published a build`);
  assert.equal(stdout.toString("utf8"), "", `${stage} evidence emitted non-fixed stdout`);
  assert.equal(stderr.toString("utf8"), `[win-authority-stage:${stage}:${diagnostic}]\n`);
  assert.ok(receiptBytes.byteLength > 0 && receiptBytes.byteLength <= 1024, `${stage} hook receipt is absent or oversized`);
  const receiptText = new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes);
  assert.equal(receiptText.endsWith("\n"), true, `${stage} hook receipt is not LF framed`);
  const receipt = JSON.parse(receiptText);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "deniedOperations", "hook", "mac", "mutationAttempted", "mutationDenied", "nonce", "stage", "version",
  ].sort());
  assert.equal(receiptText, `${canonical(receipt)}\n`, `${stage} hook receipt is not canonical`);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.stage, stage);
  assert.equal(receipt.nonce, nonce);
  assert.equal(receipt.hook, "runAuthorityLeasedBuildTool.after-native-input-authority-v1");
  assert.equal(receipt.mutationAttempted, true);
  assert.equal(receipt.mutationDenied, true);
  assert.equal(receipt.deniedOperations, 3);
  assert.match(receipt.mac, /^[0-9a-f]{64}$/u);
  const { mac, ...unsigned } = receipt;
  const expectedMac = createHmac("sha256", key).update(canonical(unsigned)).digest();
  assert.equal(timingSafeEqual(Buffer.from(mac, "hex"), expectedMac), true, `${stage} hook receipt MAC is invalid`);
  assert.deepEqual(artifactSnapshot(), baseline, `${stage} changed baseline or published a new final artifact`);
  assert.deepEqual(residueSnapshot(), baselineResidue, `${stage} left protected staging residue`);
  return {
    stage, diagnostic, nonceAuthenticated: true, hookAuthenticated: true,
    mutationAttempted: true, mutationDenied: true, childAndJobsTerminated: true,
    publishedArtifactsChanged: 0, baselineArtifactsChanged: 0, stagingResidueChanged: 0,
  };
}

const completed = [];
for (const [stage, diagnostic] of [["BUILD_COMPILER", 6], ["BUILD_SOURCE", 6], ["BUILD_OUTPUT", 6]]) {
  completed.push(await runEvidence(stage, diagnostic));
}

const receiptArgument = process.argv.find((item) => item.startsWith("--receipt="));
if (receiptArgument) {
  const receipt = receiptArgument.slice("--receipt=".length);
  assert.equal(isAbsolute(receipt), true, "build evidence receipt path must be absolute");
  writeFileSync(receipt, `${JSON.stringify({ version: 2, stages: completed })}\n`, { flag: "wx", mode: 0o600 });
}
process.stdout.write("Windows authority production build evidence: stages=3 pass=3 fail=0 skipped=0 receipts=3\n");
