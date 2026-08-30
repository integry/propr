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
const fixtureNodeArgs = Object.freeze([
  "--no-warnings",
  "--import", processFixture,
  "--import", fetchFixture,
]);
assert.deepEqual(fixtureNodeArgs, [
  "--no-warnings",
  "--import", processFixture,
  "--import", fetchFixture,
]);
const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), "propr-windows-discovery-")));
const createdRoot = join(fixture, "stack-private-path-SENTINEL");
mkdirSync(createdRoot);
const root = realpathSync.native(createdRoot);
const data = join(root, "data");
const endpoint = "https://t-abc123.propr.dev";
const identity = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function tunnelFixtureEnvLines({ enabled }) {
  return [
    `PROPR_UI_TUNNEL_ENABLED=${enabled ? "true" : "false"}`,
    ...(enabled ? ["PROPR_UI_TUNNEL_TOKEN=root-token-SENTINEL"] : []),
  ];
}

const scenarioAllowlist = Object.freeze([
  "ready", "down", "disabled", "restart-required", "malformed", "oversized", "timeout",
  "identity-mismatch", "secret-sentinel", "api",
]);
const assertionStageAllowlist = Object.freeze([
  "write-env", "spawn", "signal", "exit", "bounds", "schema", "status", "endpoint",
  "identity", "reasons", "api-ready", "restart", "stderr", "sentinel", "api-spawn",
  "api-exit", "api-count",
]);
const statusKindAllowlist = Object.freeze([
  "ready", "internalFailure", "notReady", "incompatible", "invalidConfig", "timeout",
]);
const reasonCodeAllowlist = Object.freeze([
  "NOT_CONFIGURED", "TUNNEL_DISABLED", "SIDECAR_NOT_RUNNING", "API_UNREACHABLE", "API_TIMEOUT",
  "DISCOVERY_UNSUPPORTED", "DISCOVERY_INVALID", "DISCOVERY_TOO_LARGE", "API_INCOMPATIBLE",
  "IDENTITY_MISMATCH", "ENDPOINT_MISMATCH", "RESTART_REQUIRED", "INVALID_ROOT", "INVALID_ENDPOINT",
  "IDENTITY_UNAVAILABLE", "INTERNAL_FAILURE", "ACL_DIAGNOSTIC_UNAVAILABLE",
]);
const scenarioNames = new Set(scenarioAllowlist);
const assertionStages = new Set(assertionStageAllowlist);
const statusKinds = new Set(statusKindAllowlist);
const diagnosticStatuses = new Set([null, ...statusKindAllowlist]);
const reasonCodes = new Set(reasonCodeAllowlist);

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

function createFailureDiagnostic(scenario, stage, failureStatus) {
  const status = failureStatus?.status ?? null;
  const codes = failureStatus?.reasonCodes ?? [];
  if (!scenarioNames.has(scenario) || !assertionStages.has(stage) || !diagnosticStatuses.has(status)
    || !Array.isArray(codes) || codes.length > reasonCodes.size
    || new Set(codes).size !== codes.length || codes.some((code) => !reasonCodes.has(code))) {
    return { scenario: "ready", stage: "write-env", status: null, reasonCodes: [] };
  }
  return { scenario, stage, status, reasonCodes: [...codes] };
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

let currentScenario = "ready";
let currentStage = "write-env";
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
    currentScenario = scenario.name;
    currentStage = "write-env";
    failureStatus = null;
    writeFileSync(join(root, ".env"), [
      "PROPR_STACK=authorized",
      "PROPR_INSTANCE_ID=abc123",
      `PROPR_UI_PUBLIC_API_URL=${endpoint}`,
      ...tunnelFixtureEnvLines(scenario),
      "",
    ].join("\n"));
    currentStage = "spawn";
    const result = spawnSync(process.execPath, [
      ...fixtureNodeArgs,
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
    currentStage = "bounds";
    failureStatus = parseBoundedFailureStatus(result.stdout);
    currentStage = "signal";
    assert.equal(result.signal, null, scenario.name);
    currentStage = "exit";
    assert.equal(result.status, scenario.exit, scenario.name);
    currentStage = "bounds";
    assert.ok(result.stdout.length > 0 && result.stdout.length < 2048, scenario.name);
    currentStage = "schema";
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, scenario.name);
    const document = JSON.parse(result.stdout);
    currentStage = "status";
    assert.equal(document.status, scenario.status, scenario.name);
    currentStage = "endpoint";
    assert.equal(document.canonicalEndpoint, endpoint, scenario.name);
    currentStage = "identity";
    assert.equal(document.publicInstanceIdentity, identity, scenario.name);
    currentStage = "reasons";
    assert.deepEqual(document.reasonCodes, scenario.reasons, scenario.name);
    currentStage = "api-ready";
    assert.equal(document.apiReady, scenario.status === "ready", scenario.name);
    currentStage = "restart";
    assert.equal(document.restartRequired, scenario.name === "restart-required", scenario.name);
    currentStage = "stderr";
    const expectedStderr = scenario.status === "ready" ? "" : `ProPR Connect discovery: ${scenario.status}.\n`;
    assert.equal(result.stderr, expectedStderr, scenario.name);
    currentStage = "sentinel";
    for (const sentinel of [
      "root-token-SENTINEL", "connector-token-SENTINEL", "relay-token-SENTINEL",
      "github-token-SENTINEL", "docker-secret-SENTINEL", "private-path-SENTINEL", fixture,
    ]) {
      assert.equal(result.stdout.includes(sentinel), false, `${scenario.name} stdout leaked ${sentinel}`);
      assert.equal(result.stderr.includes(sentinel), false, `${scenario.name} stderr leaked ${sentinel}`);
    }
  }

  currentScenario = "api";
  currentStage = "api-spawn";
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
  currentStage = "api-exit";
  assert.equal(api.status, 0, api.stderr || api.stdout);
  currentStage = "api-count";
  const pass = [...api.stdout.matchAll(/^# pass (\d+)$/gm)].at(-1);
  const fail = [...api.stdout.matchAll(/^# fail (\d+)$/gm)].at(-1);
  assert.ok(pass && Number(pass[1]) > 0, "API discovery tests did not report passes");
  assert.equal(Number(fail?.[1]), 0, "API discovery tests reported failures");
  process.stdout.write(`Windows ordinary-user discovery proof: cli=${cases.length} api=${pass[1]} authority=1 user=${actualUser}\n`);
} catch {
  const diagnostic = createFailureDiagnostic(currentScenario, currentStage, failureStatus);
  process.stderr.write(`Windows ordinary-user discovery assertion failed: ${JSON.stringify(
    diagnostic,
  )}\n`);
  process.exitCode = 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
