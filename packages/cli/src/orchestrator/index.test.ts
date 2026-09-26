import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigManager } from "../config/ConfigManager.js";
import { connectExecutionEnvironment, getHostConfig, loadOrchestrator } from "./index.js";

function createStackRoot(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root);
  for (const dir of ["data", "logs", "repos"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, ".env"), "");
  return root;
}

function replacementConfig(rootDir: string) {
  return {
    stack: "desktop-owned", validateHostPaths: true,
    hostData: join(rootDir, "data"), hostLogs: join(rootDir, "logs"),
    hostRepos: join(rootDir, "repos"), envFileHost: join(rootDir, ".env"),
  } as never;
}

function createResumableReplacementDocker(tempDir: string, rootDir: string): {
  docker: string;
  state: string;
} {
  const docker = join(tempDir, "docker");
  const state = join(tempDir, "docker-state.json");
  writeFileSync(state, JSON.stringify({
    failedWorkerStop: false,
    containers: [
      { id: "a".repeat(64), service: "api", running: true },
      { id: "b".repeat(64), service: "worker", running: true },
    ],
  }));
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const statePath = process.env.PROPR_TEST_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'ps' && args.includes('{{.ID}}')) {
  process.stdout.write(state.containers.map(container => container.id).join('\\n') + (state.containers.length ? '\\n' : ''));
} else if (args[0] === 'ps') {
  for (const container of state.containers) {
    if (args.includes('-a') || container.running) {
      process.stdout.write('desktop-owned-' + container.service + '\\t'
        + (container.running ? 'running\\tUp' : 'exited\\tExited') + '\\t\\n');
    }
  }
} else if (args[0] === 'inspect') {
  const container = state.containers.find(candidate => candidate.id === args.at(-1));
  if (!container) process.exitCode = 1;
  else {
    const root = process.env.PROPR_TEST_MANAGED_ROOT;
    const mounts = [
      { Type: 'bind', Source: path.join(root, 'data'), Destination: '/usr/src/app/data' },
      { Type: 'bind', Source: path.join(root, 'logs'), Destination: '/usr/src/app/logs' },
      ...(container.service === 'worker'
        ? [{ Type: 'bind', Source: path.join(root, 'repos'), Destination: '/usr/src/app/repos' }]
        : [{ Type: 'bind', Source: path.join(root, '.env'), Destination: '/usr/src/app/.env' }]),
    ];
    process.stdout.write([container.id, '/desktop-owned-' + container.service, {
      'propr.stack': 'desktop-owned', 'propr.service': container.service,
    }, mounts].map(JSON.stringify).join('\\t') + '\\n');
  }
} else if (args[0] === 'stop') {
  const container = state.containers.find(candidate => candidate.id === args.at(-1));
  if (process.env.PROPR_TEST_FAIL_WORKER_STOP === '1' && container?.service === 'worker' && !state.failedWorkerStop) {
    state.failedWorkerStop = true;
    save();
    process.stderr.write('injected Docker stop failure\\n');
    process.exitCode = 1;
  } else if (container) {
    container.running = false;
    save();
  }
} else if (args[0] === 'rm') {
  state.containers = state.containers.filter(container => container.id !== args.at(-1));
  save();
}
`, { mode: 0o700 });
  chmodSync(docker, 0o700);
  return { docker, state };
}

test("explicit new root does not inherit legacy tunnel intent during start preflight", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-root-isolation-test-"));
  try {
    const rootA = createStackRoot(tempDir, "root-a");
    const rootB = createStackRoot(tempDir, "root-b");
    const configDir = join(tempDir, "config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      stackRoot: rootA,
      tunnelEnabled: true,
    }));

    const configManager = new ConfigManager(configDir);
    await configManager.init();

    const rootAHost = await getHostConfig({ configManager, root: rootA });
    assert.equal(rootAHost.cfg.uiTunnelEnabled, true);

    // This is the same resolution and validation path used by setup's
    // startStack action after the user accepts "Start the stack now?".
    const rootBHost = await getHostConfig({ configManager, root: rootB });
    assert.equal(rootBHost.cfg.uiTunnelEnabled, false);
    const preflight = rootBHost.orch.validateEnv(rootBHost.cfg);
    assert.equal(preflight.ok, true, preflight.errors.join("\n"));

    // Persisting setup's newly selected default root must not move A's intent.
    await configManager.setStackRoot(rootB);
    assert.equal(configManager.getTunnelEnabled(rootA), true);
    assert.equal(configManager.getTunnelEnabled(rootB), undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("owned-stack replacement validates mounts first and mutates immutable container IDs", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-owned-replacement-test-"));
  const rootDir = createStackRoot(tempDir, "managed-root");
  const docker = join(tempDir, "docker");
  const log = join(tempDir, "docker.jsonl");
  const originalPath = process.env.PATH;
  process.env.PROPR_TEST_DOCKER_LOG = log;
  process.env.PROPR_TEST_MANAGED_ROOT = rootDir;
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const apiId = 'a'.repeat(64);
const uiId = 'b'.repeat(64);
fs.appendFileSync(process.env.PROPR_TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') process.stdout.write(apiId + '\\n' + uiId + '\\n');
if (args[0] === 'inspect') {
  const id = args.at(-1);
  const service = id === apiId ? 'api' : 'ui';
  const root = process.env.PROPR_TEST_MANAGED_ROOT;
  const mounts = service === 'api' ? [
    { Type: 'bind', Source: path.join(root, 'data'), Destination: '/usr/src/app/data' },
    { Type: 'bind', Source: path.join(root, 'logs'), Destination: '/usr/src/app/logs' },
    { Type: 'bind', Source: path.join(root, '.env'), Destination: '/usr/src/app/.env' },
  ] : [];
  process.stdout.write([id, '/desktop-owned-' + service, {
    'propr.stack': 'desktop-owned', 'propr.service': service,
  }, mounts].map(JSON.stringify).join('\\t') + '\\n');
}
`, { mode: 0o700 });
  chmodSync(docker, 0o700);
  process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
  try {
    const orch = await loadOrchestrator();
    await orch.replaceStackContainersAsync({
      stack: "desktop-owned", validateHostPaths: true,
      hostData: join(rootDir, "data"), hostLogs: join(rootDir, "logs"),
      hostRepos: join(rootDir, "repos"), envFileHost: join(rootDir, ".env"),
    } as never);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.map((call: string[]) => [call[0], call.at(-1)]), [
      ["ps", "{{.ID}}"],
      ["inspect", "a".repeat(64)], ["inspect", "b".repeat(64)],
      ["stop", "b".repeat(64)], ["rm", "b".repeat(64)],
      ["stop", "a".repeat(64)], ["rm", "a".repeat(64)],
    ]);
    const mutations = calls.filter((call: string[]) => call[0] === "stop" || call[0] === "rm");
    assert.equal(mutations.flat().some((argument: string) => /volume|network|data|credential/i.test(argument)), false);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.PROPR_TEST_DOCKER_LOG;
    delete process.env.PROPR_TEST_MANAGED_ROOT;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("owned-stack replacement is resumable after cancellation removes one container", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-cancelled-replacement-test-"));
  const rootDir = createStackRoot(tempDir, "managed-root");
  const marker = join(rootDir, ".propr-stack-replacement.json");
  const originalPath = process.env.PATH;
  const { state } = createResumableReplacementDocker(tempDir, rootDir);
  process.env.PROPR_TEST_DOCKER_STATE = state;
  process.env.PROPR_TEST_MANAGED_ROOT = rootDir;
  process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
  try {
    const orch = await loadOrchestrator();
    const cfg = replacementConfig(rootDir);
    const controller = new AbortController();
    await assert.rejects(orch.replaceStackContainersAsync(cfg, {
      signal: controller.signal,
      onLog: (line: string) => {
        if (line.includes("desktop-owned-api")) controller.abort(new Error("replacement cancelled"));
      },
    }), /replacement cancelled/);

    assert.equal(existsSync(marker), true);
    assert.equal(statSync(marker).mode & 0o777, 0o600);
    assert.equal(orch.isStackReplacementPending(cfg), true);
    assert.equal(await orch.isStackRunningAsync(cfg), false,
      "a remaining running core container must not make interrupted replacement look coherent");

    await orch.replaceStackContainersAsync(cfg);
    assert.equal(orch.isStackReplacementPending(cfg), false);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).containers, []);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.PROPR_TEST_DOCKER_STATE;
    delete process.env.PROPR_TEST_MANAGED_ROOT;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("owned-stack replacement is resumable after a Docker failure following partial removal", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-failed-replacement-test-"));
  const rootDir = createStackRoot(tempDir, "managed-root");
  const marker = join(rootDir, ".propr-stack-replacement.json");
  const originalPath = process.env.PATH;
  const { state } = createResumableReplacementDocker(tempDir, rootDir);
  process.env.PROPR_TEST_DOCKER_STATE = state;
  process.env.PROPR_TEST_MANAGED_ROOT = rootDir;
  process.env.PROPR_TEST_FAIL_WORKER_STOP = "1";
  process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
  try {
    const orch = await loadOrchestrator();
    const cfg = replacementConfig(rootDir);
    await assert.rejects(orch.replaceStackContainersAsync(cfg), /injected Docker stop failure/);

    assert.equal(existsSync(marker), true);
    assert.equal(statSync(marker).mode & 0o777, 0o600);
    assert.equal(await orch.isStackRunningAsync(cfg), false,
      "the recovery marker must force reconstruction while the failed core container is still running");
    assert.equal(orch.isStackRunning(cfg), false);
    assert.throws(() => orch.startStack(cfg), /re-run `propr setup` to resume/,
      "the synchronous start path must not bypass an incomplete validated replacement");
    const interrupted = JSON.parse(readFileSync(state, "utf8"));
    assert.deepEqual(interrupted.containers.map((container: { service: string }) => container.service), ["worker"]);
    assert.equal(interrupted.containers[0].running, true);

    await orch.replaceStackContainersAsync(cfg);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).containers, []);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.PROPR_TEST_DOCKER_STATE;
    delete process.env.PROPR_TEST_MANAGED_ROOT;
    delete process.env.PROPR_TEST_FAIL_WORKER_STOP;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("owned-stack replacement refuses a same-label container mounted from another root without mutation", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-foreign-replacement-test-"));
  const rootDir = createStackRoot(tempDir, "managed-root");
  const foreignRoot = createStackRoot(tempDir, "foreign-root");
  const docker = join(tempDir, "docker");
  const log = join(tempDir, "docker.jsonl");
  const originalPath = process.env.PATH;
  process.env.PROPR_TEST_DOCKER_LOG = log;
  process.env.PROPR_TEST_FOREIGN_ROOT = foreignRoot;
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const id = 'c'.repeat(64);
fs.appendFileSync(process.env.PROPR_TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') process.stdout.write(id + '\\n');
if (args[0] === 'inspect') {
  const root = process.env.PROPR_TEST_FOREIGN_ROOT;
  const mounts = [
    { Type: 'bind', Source: path.join(root, 'data'), Destination: '/usr/src/app/data' },
    { Type: 'bind', Source: path.join(root, 'logs'), Destination: '/usr/src/app/logs' },
    { Type: 'bind', Source: path.join(root, '.env'), Destination: '/usr/src/app/.env' },
  ];
  process.stdout.write([id, '/desktop-owned-api', {
    'propr.stack': 'desktop-owned', 'propr.service': 'api',
  }, mounts].map(JSON.stringify).join('\\t') + '\\n');
}
`, { mode: 0o700 });
  chmodSync(docker, 0o700);
  process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
  try {
    const orch = await loadOrchestrator();
    await assert.rejects(orch.replaceStackContainersAsync({
      stack: "desktop-owned", validateHostPaths: true,
      hostData: join(rootDir, "data"), hostLogs: join(rootDir, "logs"),
      hostRepos: join(rootDir, "repos"), envFileHost: join(rootDir, ".env"),
    } as never), /ownership metadata does not match/);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.map((call: string[]) => call[0]), ["ps", "inspect"]);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.PROPR_TEST_DOCKER_LOG;
    delete process.env.PROPR_TEST_FOREIGN_ROOT;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Connect forwards only validated Docker transport and process bootstrap variables", () => {
  const windows = process.platform === "win32";
  const platform = windows ? "win32" : process.platform;
  const path = windows ? "C:\\trusted\\bin" : "/trusted/bin";
  const certPath = windows ? "C:\\private\\certs" : "/private/certs";
  const configPath = windows ? "C:\\private\\docker-config" : "/private/docker-config";
  const sshSocket = windows ? "\\\\.\\pipe\\trusted-ssh-agent" : "/trusted/ssh-agent";
  const platformHome = windows ? { USERPROFILE: "C:\\Users\\trusted" } : { HOME: "/trusted/home" };
  const environment = connectExecutionEnvironment({
    PATH: path,
    DOCKER_HOST: "ssh://docker.example.test",
    DOCKER_CONTEXT: "remote-context",
    DOCKER_TLS: "1",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: certPath,
    DOCKER_CONFIG: configPath,
    PROPR_UI_TUNNEL_TOKEN: "must-not-cross",
    ...platformHome,
    HOME: windows ? "/must/not/cross" : platformHome.HOME,
    SSH_AUTH_SOCK: sshSocket,
    DOCKER_AUTH_CONFIG: "must-not-cross",
    NODE_OPTIONS: "must-not-cross",
    HTTPS_PROXY: "must-not-cross",
  }, platform);
  assert.deepEqual(environment, {
    PATH: path,
    DOCKER_HOST: "ssh://docker.example.test",
    DOCKER_CONTEXT: "remote-context",
    DOCKER_TLS: "1",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: certPath,
    DOCKER_CONFIG: configPath,
    ...platformHome,
    SSH_AUTH_SOCK: sshSocket,
  });
  for (const invalid of [
    { DOCKER_HOST: "x".repeat(4097) },
    { DOCKER_CONTEXT: "x".repeat(256) },
    { DOCKER_CONTEXT: "é".repeat(128) },
    { DOCKER_TLS: "" },
    { DOCKER_TLS: "x".repeat(17) },
    { DOCKER_CERT_PATH: "private\0path" },
    { DOCKER_CONFIG: 42 },
    { DOCKER_TLS_VERIFY: "" },
  ]) assert.throws(() => connectExecutionEnvironment(invalid, platform), /environment/);

  assert.deepEqual(connectExecutionEnvironment({
    PATH: "C:\\trusted\\bin",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\trusted",
    HOME: "/must/not/cross",
  }, "win32"), {
    PATH: "C:\\trusted\\bin",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\trusted",
  });
  for (const invalidHome of [
    { USERPROFILE: "relative" },
    { HOMEDRIVE: "C:" },
    { HOMEPATH: "\\Users\\trusted" },
    { HOMEDRIVE: "relative", HOMEPATH: "\\Users\\trusted" },
    { HOMEDRIVE: "C:", HOMEPATH: "relative" },
  ]) assert.throws(() => connectExecutionEnvironment(invalidHome, "win32"), /platform environment/);
});
