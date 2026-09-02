#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  process.stderr.write("Ordinary-user Windows Connect discovery proof requires Windows.\n");
  process.exit(1);
}

const expectedUser = process.argv[2];
const preparedFixture = process.argv[3];
const actualUser = userInfo().username;

const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "packages", "cli", "dist", "index.js");
const fetchFixture = pathToFileURL(join(repo, "test", "fixtures", "connectFetchMock.mjs")).href;
const processFixture = pathToFileURL(join(repo, "test", "fixtures", "windowsConnectProcessMock.mjs")).href;
const authorityModule = pathToFileURL(join(repo, "packages", "cli", "dist", "connectRootAuthority.js")).href;
const windowsAuthorityModule = pathToFileURL(join(repo, "packages", "cli", "dist", "connectWindowsAuthority.js")).href;
const initStackModule = pathToFileURL(join(repo, "packages", "cli", "dist", "commands", "initStack.js")).href;
const configManagerModule = pathToFileURL(join(repo, "packages", "cli", "dist", "config", "ConfigManager.js")).href;
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
const fixture = realpathSync.native(preparedFixture);
const root = realpathSync.native(join(fixture, "stack-private-path-SENTINEL"));
const endpoint = "https://t-abc123.propr.dev";
const identity = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function tunnelFixtureEnvLines({ enabled }) {
  return [
    `PROPR_UI_TUNNEL_ENABLED=${enabled ? "true" : "false"}`,
    ...(enabled ? ["PROPR_UI_TUNNEL_TOKEN=root-token-SENTINEL"] : []),
  ];
}

function windowsRootEnvironment(systemRootMode, systemRoot, windir, untrustedRoot) {
  if (systemRootMode === "missing") return {};
  return {
    SYSTEMROOT: systemRoot,
    WINDIR: systemRootMode === "mismatched" ? untrustedRoot : windir,
  };
}

const WINDOWS_ROOT_MISSING_MARKER = "PROPR_TEST_WINDOWS_ROOT_MISSING";
const WINDOWS_ROOT_MISSING_MARKER_VALUE = "windows-root-missing-v1";

function missingWindowsRootFixtureEnvironment(systemRootMode) {
  return systemRootMode === "missing"
    ? { [WINDOWS_ROOT_MISSING_MARKER]: WINDOWS_ROOT_MISSING_MARKER_VALUE }
    : {};
}

const WINDOWS_ROOT_UNTRUSTED_MARKER = "PROPR_TEST_WINDOWS_ROOT_UNTRUSTED";
const WINDOWS_ROOT_UNTRUSTED_MARKER_VALUE = "windows-root-untrusted-v1";
const WINDOWS_ROOT_UNTRUSTED_PATH = "PROPR_TEST_WINDOWS_ROOT_UNTRUSTED_PATH";

function untrustedWindowsRootFixtureEnvironment(systemRootMode, untrustedRoot) {
  return systemRootMode === "untrusted"
    ? {
        [WINDOWS_ROOT_UNTRUSTED_MARKER]: WINDOWS_ROOT_UNTRUSTED_MARKER_VALUE,
        [WINDOWS_ROOT_UNTRUSTED_PATH]: untrustedRoot,
      }
    : {};
}

const scenarioAllowlist = Object.freeze([
  "ready", "down", "disabled", "restart-required", "malformed", "oversized", "timeout",
  "identity-mismatch", "secret-sentinel", "api", "path-aba", "authority-malformed", "authority-oversized",
  "authority-extra-key", "authority-duplicate", "authority-entry-count", "authority-entry-shape",
  "authority-stderr", "authority-nonzero",
  "authority-timeout", "authority-descriptor-mismatch", "authority-index-mismatch",
  "authority-kind-mismatch", "authority-authority-kind-mismatch", "authority-identity-mismatch",
  "authority-sid-mismatch", "authority-broad-write", "authority-inherited-write",
  "authority-unprotected", "authority-owner-mismatch", "authority-reparse",
  "authority-missing-system-root", "authority-mismatched-system-root", "authority-untrusted-system-root",
]);
const assertionStageAllowlist = Object.freeze([
  "native-timing", "authority-probe", "scaffold", "identity-assertion", "config-init", "config-save",
  "config-assertion",
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
  "DESKTOP_AUTHENTICATION_UNSUPPORTED",
  "IDENTITY_MISMATCH", "ENDPOINT_MISMATCH", "RESTART_REQUIRED", "INVALID_ROOT", "INVALID_ENDPOINT",
  "IDENTITY_UNAVAILABLE", "INTERNAL_FAILURE", "ACL_DIAGNOSTIC_UNAVAILABLE",
]);
const nativeStageAllowlist = Object.freeze([
  "resolver:env", "resolver:canonical", "resolver:global-open", "resolver:global-id",
  "spawn:create", "spawn:error", "spawn:timeout", "spawn:status", "spawn:stderr", "spawn:cleanup",
  "probe:entry", "probe:baseline", "probe:reflection-emit", "probe:win32", "probe:standard-handle", "probe:output",
  "broker:ps-version", "broker:job", "broker:fd", "broker:fd-duplicate", "broker:index-info-initial",
  "broker:security-info", "broker:acl", "broker:json", "broker:current-user-sid",
  "broker:index-info-revalidation", "broker:index-info-decode", "broker:index-info-compose", "broker:entry-format",
  "broker:entry-flags", "broker:entry-rules", "broker:entry-build",
  "parent:utf8", "parent:json-parse", "parent:json-canonical", "parent:document-shape",
  "parent:entry-count", "parent:entry-shape", "parent:json-shape", "parent:descriptor-bind", "parent:post-bind",
]);
const probeMilestoneAllowlist = Object.freeze([
  "none", "entry-ps51-desktop-x64", "constant-json", "reflection-emit", "harmless-win32",
  "standard-handle-identity",
]);
const probeTimingAllowlist = Object.freeze([
  "under-5s", "5-to-15s", "15-to-30s", "30-to-45s", "45-to-60s", "at-least-60s",
]);
const WINDOWS_PRODUCT_AUTHORITY_PHASE_COUNT = 2;
const WINDOWS_PRODUCT_SCENARIO_OVERHEAD_MS = 15_000;
const scenarioNames = new Set(scenarioAllowlist);
const assertionStages = new Set(assertionStageAllowlist);
const statusKinds = new Set(statusKindAllowlist);
const diagnosticStatuses = new Set([null, ...statusKindAllowlist]);
const reasonCodes = new Set(reasonCodeAllowlist);
const nativeStages = new Set(nativeStageAllowlist);
const probeMilestones = new Set(probeMilestoneAllowlist);
const probeTimings = new Set(probeTimingAllowlist);

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

function createFailureDiagnostic(scenario, stage, failureStatus, nativeStage, probe) {
  const status = failureStatus?.status ?? null;
  const codes = failureStatus?.reasonCodes ?? [];
  if (!scenarioNames.has(scenario) || !assertionStages.has(stage) || !diagnosticStatuses.has(status)
    || (nativeStage !== null && !nativeStages.has(nativeStage))
    || (probe.milestone !== null && !probeMilestones.has(probe.milestone))
    || (probe.timing !== null && !probeTimings.has(probe.timing))
    || !Array.isArray(codes) || codes.length > reasonCodes.size
    || new Set(codes).size !== codes.length || codes.some((code) => !reasonCodes.has(code))) {
    return {
      scenario: "ready", stage: "write-env", nativeStage: null, status: null, reasonCodes: [],
      probeMilestone: null, probeTiming: null,
    };
  }
  return {
    scenario, stage, nativeStage, status, reasonCodes: [...codes],
    probeMilestone: probe.milestone,
    probeTiming: probe.timing,
  };
}

function extractNativeDiagnostic(stderr) {
  let nativeStage = null;
  const applicationStderr = stderr.replace(/^\[propr-windows-native-stage:([^\]]+)\]\r?\n/gm, (_line, stage) => {
    nativeStage = nativeStages.has(stage) ? stage : "parent:json-shape";
    return "";
  });
  return { applicationStderr, nativeStage };
}

const cases = [
  { name: "ready", fetch: "ready", docker: "ready", enabled: true, status: "ready", exit: 0, reasons: [] },
  { name: "down", fetch: "ready", docker: "down", authorityMode: "valid-authority", enabled: true, status: "notReady", exit: 0, reasons: ["SIDECAR_NOT_RUNNING"] },
  { name: "disabled", fetch: "ready", docker: "ready", authorityMode: "valid-authority", enabled: false, status: "notReady", exit: 0, reasons: ["TUNNEL_DISABLED"] },
  { name: "restart-required", fetch: "restart-required", docker: "ready", authorityMode: "valid-authority", enabled: true, status: "notReady", exit: 0, reasons: ["ENDPOINT_MISMATCH", "RESTART_REQUIRED"] },
  { name: "malformed", fetch: "invalid", docker: "ready", authorityMode: "valid-authority", enabled: true, status: "incompatible", exit: 2, reasons: ["DISCOVERY_INVALID"] },
  { name: "oversized", fetch: "oversized", docker: "ready", authorityMode: "valid-authority", enabled: true, status: "incompatible", exit: 2, reasons: ["DISCOVERY_TOO_LARGE"] },
  { name: "timeout", fetch: "timeout", docker: "ready", authorityMode: "valid-authority", enabled: true, status: "timeout", exit: 0, reasons: ["API_TIMEOUT"] },
  { name: "identity-mismatch", fetch: "identity-mismatch", docker: "ready", authorityMode: "valid-authority", enabled: true, status: "notReady", exit: 0, reasons: ["IDENTITY_MISMATCH"] },
  { name: "secret-sentinel", fetch: "secret-sentinel", docker: "ready", authorityMode: "valid-authority", enabled: true, status: "notReady", exit: 0, reasons: ["API_UNREACHABLE"] },
];
const authorityFailures = [
  { name: "path-aba", mode: "path-aba", reason: "INVALID_ROOT" },
  { name: "authority-malformed", mode: "malformed", nativeStage: "parent:json-parse" },
  { name: "authority-oversized", mode: "oversized" },
  { name: "authority-extra-key", mode: "extra-key", nativeStage: "parent:document-shape" },
  { name: "authority-duplicate", mode: "duplicate", nativeStage: "parent:json-canonical" },
  { name: "authority-entry-count", mode: "entry-count", nativeStage: "parent:entry-count" },
  { name: "authority-entry-shape", mode: "entry-shape", nativeStage: "parent:entry-shape" },
  { name: "authority-stderr", mode: "stderr" },
  { name: "authority-nonzero", mode: "nonzero" },
  { name: "authority-timeout", mode: "timeout" },
  { name: "authority-descriptor-mismatch", mode: "descriptor-mismatch" },
  { name: "authority-index-mismatch", mode: "index-mismatch" },
  { name: "authority-kind-mismatch", mode: "kind-mismatch" },
  { name: "authority-authority-kind-mismatch", mode: "authority-kind-mismatch" },
  { name: "authority-identity-mismatch", mode: "identity-mismatch" },
  { name: "authority-sid-mismatch", mode: "sid-mismatch" },
  { name: "authority-broad-write", mode: "broad-write", reason: "INVALID_ROOT" },
  { name: "authority-inherited-write", mode: "inherited-write", reason: "INVALID_ROOT" },
  { name: "authority-unprotected", mode: "unprotected", reason: "INVALID_ROOT" },
  { name: "authority-owner-mismatch", mode: "owner-mismatch", reason: "INVALID_ROOT" },
  { name: "authority-reparse", mode: "reparse", reason: "INVALID_ROOT" },
  { name: "authority-missing-system-root", systemRootMode: "missing", nativeStage: "resolver:env" },
  { name: "authority-mismatched-system-root", systemRootMode: "mismatched" },
  { name: "authority-untrusted-system-root", systemRootMode: "untrusted", nativeStage: "resolver:global-id" },
];

let currentScenario = "ready";
let currentStage = "write-env";
let failureStatus = null;
let currentNativeStage = null;
const nativeProbe = { milestone: null, timing: null, evidence: null };
try {
  assert.ok(expectedUser && actualUser.toLowerCase() === expectedUser.toLowerCase(), "proof did not run as the limited user");
  currentStage = "native-timing";
  const nativeAuthority = await import(windowsAuthorityModule);
  const WINDOWS_PRODUCT_SCENARIO_TIMEOUT_MS = (
    WINDOWS_PRODUCT_AUTHORITY_PHASE_COUNT * nativeAuthority.WINDOWS_INSPECTION_TIMEOUT_MS
  ) + WINDOWS_PRODUCT_SCENARIO_OVERHEAD_MS;
  const probeFd = openSync(
    fixture,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    try {
      const proof = nativeAuthority.runWindowsNativeTimingProbe(probeFd);
      assert.equal(proof.version, 1);
      nativeProbe.milestone = proof.lastMilestone;
      nativeProbe.timing = proof.timingBucket;
      if (proof.outcome === "timeout") currentNativeStage = "spawn:timeout";
      assert.equal(proof.outcome, "complete");
      assert.deepEqual(proof.milestones.map(({ milestone }) => milestone), [
        "entry-ps51-desktop-x64", "constant-json", "reflection-emit", "harmless-win32",
        "standard-handle-identity",
      ]);
      assert.ok(proof.milestones.every(({ milestone, timingBucket }) => (
        probeMilestones.has(milestone) && probeTimings.has(timingBucket)
      )));
      nativeProbe.evidence = proof.milestones.map(
        ({ milestone, timingBucket }) => `${milestone}:${timingBucket}`,
      ).join(",");
    } catch (error) {
      currentNativeStage = nativeStages.has(error?.stage)
        ? error.stage
        : (currentNativeStage ?? "parent:json-shape");
      throw error;
    }
  } finally {
    closeSync(probeFd);
  }
  currentStage = "authority-probe";
  const authority = await import(authorityModule);
  await assert.rejects(
    authority.protectWindowsSetupEntries([{ path: root, kind: "directory" }]),
    (error) => error?.code === authority.WINDOWS_AUTHORITY_REQUIRED_CODE
      && /authority is required/i.test(error.message)
      && /#1997/.test(error.message),
    "privileged Windows mutation did not return the actionable follow-up result",
  );

  // Privileged mutation stays deferred even though read-only discovery now
  // inspects the already-open descriptors through the OS PowerShell boundary.
  currentStage = "scaffold";
  const { scaffoldStack } = await import(initStackModule);
  const mutationRoot = realpathSync.native(mkdtempSync(join(fixture, "stack-")));
  writeFileSync(join(mutationRoot, ".env"), "SESSION_SECRET=existing\nNODE_ENV=production\n");
  const scaffold = await scaffoldStack(
    { root: mutationRoot },
    { persistStackRoot: async () => undefined },
  );
  currentStage = "identity-assertion";
  assert.equal(scaffold.envSkipped, true);
  assert.ok(readFileSync(join(mutationRoot, "data", "public-instance-identity.json"), "utf8").length > 0);

  currentStage = "config-init";
  const { ConfigManager } = await import(configManagerModule);
  const configDirectory = join(fixture, "config");
  const manager = new ConfigManager(configDirectory, { warn: () => undefined });
  await manager.init();
  currentStage = "config-save";
  await manager.save();
  currentStage = "config-assertion";
  assert.deepEqual(JSON.parse(readFileSync(join(configDirectory, "config.json"), "utf8")), {});

  for (const scenario of cases) {
    currentScenario = scenario.name;
    currentStage = "write-env";
    failureStatus = null;
    currentNativeStage = null;
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
      timeout: WINDOWS_PRODUCT_SCENARIO_TIMEOUT_MS,
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
        ...(scenario.authorityMode ? {
          PROPR_TEST_AUTHORITY_MODE: scenario.authorityMode,
          PROPR_TEST_AUTHORITY_ROOT: root,
        } : {}),
        PROPR_CONNECTOR_TOKEN: "connector-token-SENTINEL",
        PROPR_RELAY_TOKEN: "relay-token-SENTINEL",
        GITHUB_TOKEN: "github-token-SENTINEL",
      },
    });
    const nativeDiagnostic = extractNativeDiagnostic(result.stderr);
    currentNativeStage = nativeDiagnostic.nativeStage;
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
    assert.equal(nativeDiagnostic.applicationStderr, expectedStderr, scenario.name);
    currentStage = "sentinel";
    for (const sentinel of [
      "root-token-SENTINEL", "connector-token-SENTINEL", "relay-token-SENTINEL",
      "github-token-SENTINEL", "docker-secret-SENTINEL", "private-path-SENTINEL", fixture,
    ]) {
      assert.equal(result.stdout.includes(sentinel), false, `${scenario.name} stdout leaked ${sentinel}`);
      assert.equal(nativeDiagnostic.applicationStderr.includes(sentinel), false, `${scenario.name} stderr leaked ${sentinel}`);
    }
  }

  for (const scenario of authorityFailures) {
    currentScenario = scenario.name;
    currentStage = "spawn";
    failureStatus = null;
    currentNativeStage = null;
    const result = spawnSync(process.execPath, [
      ...fixtureNodeArgs,
      cli,
      "connect", "status", "--json", "--root", root,
    ], {
      cwd: fixture,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: WINDOWS_PRODUCT_SCENARIO_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      env: {
        PATH: dirname(process.execPath),
        PATHEXT: process.env.PATHEXT,
        ...windowsRootEnvironment(
          scenario.systemRootMode,
          process.env.SystemRoot,
          process.env.WINDIR,
          fixture,
        ),
        ...missingWindowsRootFixtureEnvironment(scenario.systemRootMode),
        ...untrustedWindowsRootFixtureEnvironment(scenario.systemRootMode, fixture),
        COMSPEC: process.env.ComSpec,
        USERPROFILE: process.env.USERPROFILE,
        HOMEDRIVE: process.env.HOMEDRIVE,
        HOMEPATH: process.env.HOMEPATH,
        PROPR_TEST_DISCOVERY_MODE: "ready",
        PROPR_TEST_DOCKER_MODE: "ready",
        PROPR_TEST_PUBLIC_IDENTITY: identity,
        PROPR_TEST_AUTHORITY_MODE: scenario.mode,
        ...(scenario.mode === "path-aba" ? { PROPR_TEST_AUTHORITY_ROOT: root } : {}),
      },
    });
    const nativeDiagnostic = extractNativeDiagnostic(result.stderr);
    currentNativeStage = nativeDiagnostic.nativeStage;
    if (scenario.nativeStage !== undefined) {
      assert.equal(currentNativeStage, scenario.nativeStage, scenario.name);
    }
    currentStage = "bounds";
    failureStatus = parseBoundedFailureStatus(result.stdout);
    currentStage = "signal";
    assert.equal(result.signal, null, scenario.name);
    currentStage = "exit";
    assert.equal(result.status, 1, scenario.name);
    currentStage = "schema";
    const document = JSON.parse(result.stdout);
    currentStage = "status";
    assert.equal(document.status, "invalidConfig", scenario.name);
    currentStage = "reasons";
    assert.deepEqual(document.reasonCodes, [scenario.reason ?? "ACL_DIAGNOSTIC_UNAVAILABLE"], scenario.name);
    currentStage = "stderr";
    assert.equal(nativeDiagnostic.applicationStderr, "ProPR Connect discovery: invalidConfig.\n", scenario.name);
    currentStage = "sentinel";
    for (const sentinel of [
      fixture, "private-path-SENTINEL", "attacker-replacement-SENTINEL",
      "S-1-5-21-999", "raw-error-SENTINEL",
    ]) {
      assert.equal(result.stdout.includes(sentinel), false, scenario.name);
      assert.equal(nativeDiagnostic.applicationStderr.includes(sentinel), false, scenario.name);
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
  process.stdout.write(`Windows ordinary-user discovery proof: ready=standard-handle-passed native-timing=${nativeProbe.evidence};total:${nativeProbe.timing} cli=${cases.length} api=${pass[1]} authority=${authorityFailures.length}\n`);
} catch {
  const diagnostic = createFailureDiagnostic(
    currentScenario, currentStage, failureStatus, currentNativeStage, nativeProbe,
  );
  process.stderr.write(`Windows ordinary-user discovery assertion failed: ${JSON.stringify(
    diagnostic,
  )}\n`);
  process.exitCode = 1;
} finally {
  // The elevated workflow owner removes the prepared fixture after the
  // limited-user process exits.
}
