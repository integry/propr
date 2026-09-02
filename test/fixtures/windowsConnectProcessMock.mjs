import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { fstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

const WINDOWS_ROOT_MISSING_MARKER = "PROPR_TEST_WINDOWS_ROOT_MISSING";
const WINDOWS_ROOT_MISSING_MARKER_VALUE = "windows-root-missing-v1";

function consumeMissingWindowsRootFixtureMarker(environment = process.env) {
  const marker = Object.keys(environment).find((name) => name === WINDOWS_ROOT_MISSING_MARKER);
  if (marker === undefined || environment[marker] !== WINDOWS_ROOT_MISSING_MARKER_VALUE) return;
  delete environment[marker];
  for (const name of Object.keys(environment)) {
    if (/^(?:systemroot|windir)$/i.test(name)) delete environment[name];
  }
}

const WINDOWS_ROOT_UNTRUSTED_MARKER = "PROPR_TEST_WINDOWS_ROOT_UNTRUSTED";
const WINDOWS_ROOT_UNTRUSTED_MARKER_VALUE = "windows-root-untrusted-v1";
const WINDOWS_ROOT_UNTRUSTED_PATH = "PROPR_TEST_WINDOWS_ROOT_UNTRUSTED_PATH";

function consumeUntrustedWindowsRootFixtureMarker(environment = process.env, fixtureRoot = process.cwd()) {
  const marker = Object.keys(environment).find((name) => name === WINDOWS_ROOT_UNTRUSTED_MARKER);
  const rootPath = Object.keys(environment).find((name) => name === WINDOWS_ROOT_UNTRUSTED_PATH);
  if (
    marker === undefined
    || environment[marker] !== WINDOWS_ROOT_UNTRUSTED_MARKER_VALUE
    || rootPath === undefined
    || typeof environment[rootPath] !== "string"
    || resolve(environment[rootPath]).toLowerCase() !== resolve(fixtureRoot).toLowerCase()
  ) return;
  const untrustedRoot = environment[rootPath];
  delete environment[marker];
  delete environment[rootPath];
  for (const name of Object.keys(environment)) {
    if (/^(?:systemroot|windir)$/i.test(name)) delete environment[name];
  }
  environment.SystemRoot = untrustedRoot;
  environment.WINDIR = untrustedRoot;
}

consumeMissingWindowsRootFixtureMarker();
consumeUntrustedWindowsRootFixtureMarker();

const originalSpawnSync = childProcess.spawnSync;
const originalSpawn = childProcess.spawn;
const forbidden = /(?:connect-authority|ProPRConnectAuthority|pwsh|csc|msiexec)(?:\.exe)?$/i;
let abaPerformed = false;
let authorityInvocation = 0;
const nativeStages = new Set([
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
globalThis[Symbol.for("propr.test.windowsNativeDiagnostic")] = (stage) => {
  const fixed = nativeStages.has(stage) ? stage : "parent:json-shape";
  process.stderr.write(`[propr-windows-native-stage:${fixed}]\n`);
};

function authorityDocument(args, options, mode, invocation = authorityInvocation) {
  const stat = fstatSync(options.stdio[0], { bigint: true });
  const identity = { device: stat.dev.toString(10), file: stat.ino.toString(10) };
  const userSid = "S-1-5-21-100-200-300-1001";
  const entries = [{
    currentUserSid: userSid,
    ownerSid: userSid,
    daclProtected: true,
    reparsePoint: false,
    volumeSerialNumber: identity.device,
    fileId: identity.file,
    verifiedVolumeSerialNumber: identity.device,
    verifiedFileId: identity.file,
    rules: [{
      identitySid: userSid,
      inherited: false,
      accessType: "allow",
      appliesToSelf: true,
      rights: "2032127",
    }],
  }];
  const protectedEntry = entries[0];
  if (mode === "descriptor-mismatch") {
    entries[0].fileId = (BigInt(entries[0].fileId) + 1n).toString(10);
    entries[0].verifiedFileId = entries[0].fileId;
  } else if (mode === "index-mismatch") entries[0].extraIndex = 1;
  else if (mode === "kind-mismatch") entries[0].extraKind = "file";
  else if (mode === "authority-kind-mismatch") entries[0].extraAuthorityKind = "root";
  else if (mode === "identity-mismatch") {
    entries[0].fileId = (BigInt(entries[0].fileId) + 1n).toString(10);
  } else if (mode === "sid-mismatch" && invocation > 1) {
    entries[0].currentUserSid = "S-1-5-21-100-200-300-1002";
  } else if (mode === "broad-write" && protectedEntry) {
    protectedEntry.rules = [{
      identitySid: "S-1-1-0", inherited: false, accessType: "allow", appliesToSelf: true, rights: "2",
    }];
  } else if (mode === "inherited-write" && protectedEntry) {
    protectedEntry.rules[0].inherited = true;
  } else if (mode === "unprotected" && protectedEntry) {
    protectedEntry.daclProtected = false;
  } else if (mode === "owner-mismatch" && protectedEntry) {
    protectedEntry.ownerSid = "S-1-5-18";
  } else if (mode === "reparse" && protectedEntry) {
    protectedEntry.reparsePoint = true;
  }
  return JSON.stringify({ version: 1, entries });
}

function fakeAuthorityChild(args, options, mode) {
  const invocation = authorityInvocation += 1;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 0x7000_0000 + authorityInvocation;
  child.exitCode = null;
  child.signalCode = null;
  let closed = false;
  const close = (status, signal = null) => {
    if (closed) return;
    closed = true;
    child.exitCode = status;
    child.signalCode = signal;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit("close", status, signal));
  };
  child.kill = () => {
    close(null, "SIGKILL");
    return true;
  };
  queueMicrotask(() => {
    if (closed) return;
    if (mode === "timeout") {
      const error = Object.assign(new Error("private-path-SENTINEL"), { code: "ETIMEDOUT" });
      child.emit("error", error);
      return;
    }
    if (mode === "malformed") child.stdout.write("{");
    else if (mode === "oversized") child.stdout.write("x".repeat(128 * 1024 + 1));
    else if (mode === "extra-key") child.stdout.write('{"version":1,"entries":[],"extra":true}');
    else if (mode === "duplicate") child.stdout.write('{"version":1,"version":1,"entries":[]}');
    else if (mode === "entry-count") child.stdout.write('{"version":1,"entries":[]}');
    else if (mode === "entry-shape") {
      const document = JSON.parse(authorityDocument(args, options, mode, invocation));
      document.entries[0].extra = true;
      child.stdout.write(JSON.stringify(document));
    } else if (mode === "stderr") child.stderr.write("private-path-SENTINEL S-1-5-21-999 raw-error-SENTINEL");
    else if (mode !== "nonzero") child.stdout.write(authorityDocument(args, options, mode, invocation));
    close(mode === "nonzero" ? 70 : 0);
  });
  return child;
}

childProcess.spawn = (command, args, options) => {
  const executable = String(command);
  if (forbidden.test(executable)) throw new Error("forbidden Windows authority executable");
  if (!/powershell\.exe$/i.test(executable)) return originalSpawn(command, args, options);
  const mode = process.env.PROPR_TEST_AUTHORITY_MODE;
  if (mode === "path-aba" && !abaPerformed) {
    abaPerformed = true;
    const envPath = join(process.env.PROPR_TEST_AUTHORITY_ROOT, ".env");
    const detached = `${envPath}-aba-detached`;
    renameSync(envPath, detached);
    writeFileSync(envPath, [
      "PROPR_STACK=attacker-replacement-SENTINEL",
      "PROPR_INSTANCE_ID=attacker",
      "PROPR_UI_PUBLIC_API_URL=https://t-attacker.propr.dev",
      "PROPR_UI_TUNNEL_ENABLED=true",
      "PROPR_UI_TUNNEL_TOKEN=attacker-replacement-SENTINEL",
      "",
    ].join("\n"));
    process.once("exit", () => {
      rmSync(envPath, { force: true });
      renameSync(detached, envPath);
    });
  }
  if (!mode || mode === "path-aba") return originalSpawn(command, args, options);
  return fakeAuthorityChild(args, options, mode);
};

childProcess.spawnSync = (command, args, options) => {
  const executable = String(command);
  if (forbidden.test(executable)) throw new Error("forbidden Windows authority executable");
  if (/powershell\.exe$/i.test(executable)) {
    const mode = process.env.PROPR_TEST_AUTHORITY_MODE;
    const result = (status, stdout = "", stderr = "", error = undefined, signal = null) => ({
      status, signal, error, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr),
    });
    if (mode === "malformed") return result(0, "{");
    if (mode === "oversized") return result(0, "x".repeat(128 * 1024 + 1));
    if (mode === "extra-key") return result(0, '{"version":1,"entries":[],"extra":true}');
    if (mode === "duplicate") return result(0, '{"version":1,"version":1,"entries":[]}');
    if (mode === "entry-count") return result(0, '{"version":1,"entries":[]}');
    if (mode === "entry-shape") {
      const document = JSON.parse(authorityDocument(args, options, mode));
      document.entries[0].extra = true;
      return result(0, JSON.stringify(document));
    }
    if (mode === "stderr") return result(0, "{}", "private-path-SENTINEL S-1-5-21-999 raw-error-SENTINEL");
    if (mode === "nonzero") return result(70, "", "");
    if (mode === "timeout") {
      return result(null, "", "", Object.assign(new Error("private-path-SENTINEL"), { code: "ETIMEDOUT" }), "SIGKILL");
    }
    if (mode === "valid-authority") return result(0, authorityDocument(args, options, mode));
    if ([
      "descriptor-mismatch", "index-mismatch", "kind-mismatch", "authority-kind-mismatch",
      "identity-mismatch", "sid-mismatch", "broad-write", "inherited-write", "unprotected",
      "owner-mismatch", "reparse",
    ].includes(mode)) return result(0, authorityDocument(args, options, mode));
    if (mode === "path-aba" && !abaPerformed) {
      abaPerformed = true;
      const envPath = join(process.env.PROPR_TEST_AUTHORITY_ROOT, ".env");
      const detached = `${envPath}-aba-detached`;
      renameSync(envPath, detached);
      writeFileSync(envPath, [
        "PROPR_STACK=attacker-replacement-SENTINEL",
        "PROPR_INSTANCE_ID=attacker",
        "PROPR_UI_PUBLIC_API_URL=https://t-attacker.propr.dev",
        "PROPR_UI_TUNNEL_ENABLED=true",
        "PROPR_UI_TUNNEL_TOKEN=attacker-replacement-SENTINEL",
        "",
      ].join("\n"));
      process.once("exit", () => {
        rmSync(envPath, { force: true });
        renameSync(detached, envPath);
      });
      return originalSpawnSync(command, args, options);
    }
    return originalSpawnSync(command, args, options);
  }
  if (executable.toLowerCase() !== "docker") return originalSpawnSync(command, args, options);
  const expected = [
    "ps", "-a", "--filter", "label=propr.stack=authorized", "--format",
    "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}",
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    return { status: 9, signal: null, error: undefined, stdout: "", stderr: "docker-argv-SENTINEL" };
  }
  const stdout = process.env.PROPR_TEST_DOCKER_MODE === "down"
    ? ""
    : "authorized-tunnel\trunning\tUp 1 second\t\r\n";
  return {
    status: 0,
    signal: null,
    error: undefined,
    stdout,
    stderr: "docker-secret-SENTINEL",
  };
};
syncBuiltinESMExports();
