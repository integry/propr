import childProcess from "node:child_process";
import { fstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const originalSpawnSync = childProcess.spawnSync;
const forbidden = /(?:connect-authority|ProPRConnectAuthority|pwsh|csc|msiexec)(?:\.exe)?$/i;
let abaPerformed = false;
const nativeStages = new Set([
  "resolver:env", "resolver:canonical", "resolver:global-open", "resolver:global-id",
  "spawn:create", "spawn:error", "spawn:timeout", "spawn:status", "spawn:stderr",
  "broker:ps-version", "broker:job", "broker:fd", "broker:index-info",
  "broker:security-info", "broker:acl", "broker:json",
  "parent:utf8", "parent:json-shape", "parent:descriptor-bind", "parent:post-bind",
]);
globalThis[Symbol.for("propr.test.windowsNativeDiagnostic")] = (stage) => {
  const fixed = nativeStages.has(stage) ? stage : "parent:json-shape";
  process.stderr.write(`[propr-windows-native-stage:${fixed}]\n`);
};

function authorityDocument(args, options, mode) {
  const encodedIndex = args.indexOf("-EncodedCommand") + 1;
  const source = Buffer.from(args[encodedIndex], "base64").toString("utf16le");
  const specs = [...source.matchAll(/index=(\d+);kind='(directory|file)';authorityKind='(ancestor|home|root|data|env)'/g)];
  const identities = [options.stdio[0]].map((fd) => {
    const stat = fstatSync(fd, { bigint: true });
    return { device: stat.dev.toString(10), file: stat.ino.toString(10) };
  });
  const userSid = "S-1-5-21-100-200-300-1001";
  const entries = specs.map((spec, index) => ({
    index: Number(spec[1]),
    kind: spec[2],
    authorityKind: spec[3],
    currentUserSid: userSid,
    ownerSid: userSid,
    daclProtected: true,
    reparsePoint: false,
    volumeSerialNumber: identities[index].device,
    fileId: identities[index].file,
    verifiedVolumeSerialNumber: identities[index].device,
    verifiedFileId: identities[index].file,
    rules: [{
      identitySid: userSid,
      inherited: false,
      accessType: "allow",
      appliesToSelf: true,
      rights: "2032127",
    }],
  }));
  const protectedEntry = entries.find((entry) => ["root", "data", "env"].includes(entry.authorityKind));
  if (mode === "descriptor-mismatch") {
    entries[0].fileId = (BigInt(entries[0].fileId) + 1n).toString(10);
    entries[0].verifiedFileId = entries[0].fileId;
  } else if (mode === "index-mismatch") entries[0].index += 1;
  else if (mode === "kind-mismatch") entries[0].kind = entries[0].kind === "file" ? "directory" : "file";
  else if (mode === "authority-kind-mismatch") entries[0].authorityKind = entries[0].authorityKind === "root" ? "data" : "root";
  else if (mode === "identity-mismatch") {
    entries[0].fileId = (BigInt(entries[0].fileId) + 1n).toString(10);
  } else if (mode === "sid-mismatch" && entries[0].index > 0) {
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
    if (mode === "stderr") return result(0, "{}", "private-path-SENTINEL S-1-5-21-999 raw-error-SENTINEL");
    if (mode === "nonzero") return result(70, "", "");
    if (mode === "timeout") {
      return result(null, "", "", Object.assign(new Error("private-path-SENTINEL"), { code: "ETIMEDOUT" }), "SIGKILL");
    }
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
