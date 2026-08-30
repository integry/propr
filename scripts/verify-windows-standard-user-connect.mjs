#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  process.stderr.write("Ordinary-user Windows Connect discovery proof requires Windows.\n");
  process.exit(1);
}

const expectedUser = process.argv[2];
const actualUser = userInfo().username;

const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "packages", "cli", "dist", "index.js");
const fetchFixture = pathToFileURL(join(repo, "test", "fixtures", "connectFetchMock.mjs")).href;
const processFixture = pathToFileURL(join(repo, "test", "fixtures", "windowsConnectProcessMock.mjs")).href;
const authorityModule = pathToFileURL(join(repo, "packages", "cli", "dist", "connectRootAuthority.js")).href;
const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), "propr-windows-discovery-")));
const createdRoot = join(fixture, "stack-private-path-SENTINEL");
mkdirSync(createdRoot);
const root = realpathSync.native(createdRoot);
const data = join(root, "data");
const endpoint = "https://t-abc123.propr.dev";
const identity = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const statusKinds = new Set(["ready", "internalFailure", "notReady", "incompatible", "invalidConfig", "timeout"]);
const reasonCodes = new Set([
  "NOT_CONFIGURED", "TUNNEL_DISABLED", "SIDECAR_NOT_RUNNING", "API_UNREACHABLE", "API_TIMEOUT",
  "DISCOVERY_UNSUPPORTED", "DISCOVERY_INVALID", "DISCOVERY_TOO_LARGE", "API_INCOMPATIBLE",
  "IDENTITY_MISMATCH", "ENDPOINT_MISMATCH", "RESTART_REQUIRED", "INVALID_ROOT", "INVALID_ENDPOINT",
  "IDENTITY_UNAVAILABLE", "INTERNAL_FAILURE", "ACL_DIAGNOSTIC_UNAVAILABLE",
]);

function parseBoundedFailureStatus(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0 || Buffer.byteLength(stdout, "utf8") >= 2048) return null;
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1) return null;
  try {
    const document = JSON.parse(lines[0]);
    if (!document || typeof document !== "object" || !statusKinds.has(document.status)
      || !Array.isArray(document.reasonCodes) || document.reasonCodes.length > reasonCodes.size
      || new Set(document.reasonCodes).size !== document.reasonCodes.length
      || document.reasonCodes.some((code) => !reasonCodes.has(code))) return null;
    return { status: document.status, reasonCodes: document.reasonCodes };
  } catch {
    return null;
  }
}

const cases = [
  { name: "ready", fetch: "ready", docker: "ready", enabled: true, status: "ready", exit: 0, reasons: ["ACL_DIAGNOSTIC_UNAVAILABLE"] },
  { name: "down", fetch: "ready", docker: "down", enabled: true, status: "notReady", exit: 0, reasons: ["SIDECAR_NOT_RUNNING", "ACL_DIAGNOSTIC_UNAVAILABLE"] },
  { name: "disabled", fetch: "ready", docker: "ready", enabled: false, status: "notReady", exit: 0, reasons: ["TUNNEL_DISABLED", "ACL_DIAGNOSTIC_UNAVAILABLE"] },
  { name: "restart-required", fetch: "restart-required", docker: "ready", enabled: true, status: "notReady", exit: 0, reasons: ["ENDPOINT_MISMATCH", "RESTART_REQUIRED", "ACL_DIAGNOSTIC_UNAVAILABLE"] },
  { name: "malformed", fetch: "invalid", docker: "ready", enabled: true, status: "incompatible", exit: 2, reasons: ["DISCOVERY_INVALID", "ACL_DIAGNOSTIC_UNAVAILABLE"] },
  { name: "oversized", fetch: "oversized", docker: "ready", enabled: true, status: "incompatible", exit: 2, reasons: ["DISCOVERY_TOO_LARGE", "ACL_DIAGNOSTIC_UNAVAILABLE"] },
  { name: "timeout", fetch: "timeout", docker: "ready", enabled: true, status: "timeout", exit: 0, reasons: ["API_TIMEOUT", "ACL_DIAGNOSTIC_UNAVAILABLE"] },
  { name: "identity-mismatch", fetch: "identity-mismatch", docker: "ready", enabled: true, status: "notReady", exit: 0, reasons: ["IDENTITY_MISMATCH", "ACL_DIAGNOSTIC_UNAVAILABLE"] },
  { name: "secret-sentinel", fetch: "secret-sentinel", docker: "ready", enabled: true, status: "notReady", exit: 0, reasons: ["API_UNREACHABLE", "ACL_DIAGNOSTIC_UNAVAILABLE"] },
];

let failureStatus = null;
try {
  assert.ok(expectedUser && actualUser.toLowerCase() === expectedUser.toLowerCase(), "proof did not run as the limited user");
  const authority = await import(authorityModule);
  await assert.rejects(
    authority.protectWindowsSetupEntries([{ path: root, kind: "directory" }]),
    (error) => error?.code === authority.WINDOWS_AUTHORITY_REQUIRED_CODE
      && /authority is required/i.test(error.message)
      && /#1997/.test(error.message),
    "privileged Windows mutation did not return the actionable follow-up result",
  );

  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "public-instance-identity.json"), `${JSON.stringify({
    schemaVersion: 1,
    publicInstanceIdentity: identity,
  })}\n`);

  for (const scenario of cases) {
    writeFileSync(join(root, ".env"), [
      "PROPR_STACK=authorized",
      "PROPR_INSTANCE_ID=abc123",
      `PROPR_UI_PUBLIC_API_URL=${endpoint}`,
      `PROPR_UI_TUNNEL_ENABLED=${scenario.enabled ? "true" : "false"}`,
      "PROPR_UI_TUNNEL_TOKEN=root-token-SENTINEL",
      "",
    ].join("\n"));
    const result = spawnSync(process.execPath, [
      "--import", processFixture,
      "--import", fetchFixture,
      cli,
      "connect", "status", "--json", "--root", root,
    ], {
      cwd: fixture,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 16 * 1024,
      env: {
        PATH: dirname(process.execPath),
        PATHEXT: process.env.PATHEXT,
        SYSTEMROOT: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        COMSPEC: process.env.ComSpec,
        USERPROFILE: process.env.USERPROFILE,
        HOMEDRIVE: process.env.HOMEDRIVE,
        HOMEPATH: process.env.HOMEPATH,
        PROPR_TEST_DISCOVERY_MODE: scenario.fetch,
        PROPR_TEST_DOCKER_MODE: scenario.docker,
        PROPR_TEST_PUBLIC_IDENTITY: identity,
        PROPR_CONNECTOR_TOKEN: "connector-token-SENTINEL",
        PROPR_RELAY_TOKEN: "relay-token-SENTINEL",
        GITHUB_TOKEN: "github-token-SENTINEL",
      },
    });
    failureStatus = parseBoundedFailureStatus(result.stdout);
    assert.equal(result.signal, null, scenario.name);
    assert.equal(result.status, scenario.exit, scenario.name);
    assert.ok(result.stdout.length > 0 && result.stdout.length < 2048, scenario.name);
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, scenario.name);
    const document = JSON.parse(result.stdout);
    assert.equal(document.status, scenario.status, scenario.name);
    assert.equal(document.canonicalEndpoint, endpoint, scenario.name);
    assert.equal(document.publicInstanceIdentity, identity, scenario.name);
    assert.deepEqual(document.reasonCodes, scenario.reasons, scenario.name);
    assert.equal(document.apiReady, scenario.status === "ready", scenario.name);
    assert.equal(document.restartRequired, scenario.name === "restart-required", scenario.name);
    const expectedStderr = scenario.status === "ready" ? "" : `ProPR Connect discovery: ${scenario.status}.\n`;
    assert.equal(result.stderr, expectedStderr, scenario.name);
    for (const sentinel of [
      "root-token-SENTINEL", "connector-token-SENTINEL", "relay-token-SENTINEL",
      "github-token-SENTINEL", "docker-secret-SENTINEL", "private-path-SENTINEL", fixture,
    ]) {
      assert.equal(result.stdout.includes(sentinel), false, `${scenario.name} stdout leaked ${sentinel}`);
      assert.equal(result.stderr.includes(sentinel), false, `${scenario.name} stderr leaked ${sentinel}`);
    }
  }

  failureStatus = null;
  const api = spawnSync(process.execPath, [
    "--import", "tsx", "--test", join(repo, "packages", "api", "test", "statusRoutes.test.ts"),
  ], {
    cwd: repo,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  assert.equal(api.status, 0, api.stderr || api.stdout);
  const pass = [...api.stdout.matchAll(/^# pass (\d+)$/gm)].at(-1);
  const fail = [...api.stdout.matchAll(/^# fail (\d+)$/gm)].at(-1);
  assert.ok(pass && Number(pass[1]) > 0, "API discovery tests did not report passes");
  assert.equal(Number(fail?.[1]), 0, "API discovery tests reported failures");
  process.stdout.write(`Windows ordinary-user discovery proof: cli=${cases.length} api=${pass[1]} authority=1 user=${actualUser}\n`);
} catch {
  process.stderr.write(`Windows ordinary-user discovery assertion failed: ${JSON.stringify(
    failureStatus ?? { status: null, reasonCodes: [] },
  )}\n`);
  process.exitCode = 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
