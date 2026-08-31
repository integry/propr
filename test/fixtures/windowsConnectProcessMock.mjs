import childProcess from "node:child_process";
import { fstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const originalSpawnSync = childProcess.spawnSync;
const forbidden = /(?:connect-authority|ProPRConnectAuthority|pwsh|csc|msiexec)(?:\.exe)?$/i;
let abaPerformed = false;

function authorityDocument(args, options, mode) {
  const encodedIndex = args.indexOf("-EncodedCommand") + 1;
  const source = Buffer.from(args[encodedIndex], "base64").toString("utf16le");
  const specs = [...source.matchAll(/@\((\d+),'(directory|file)','(ancestor|home|root|data|env)'\)/g)];
  const identities = options.stdio.slice(3).map((fd) => {
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
  if (mode === "descriptor-mismatch" && entries.length > 1) {
    entries[0].volumeSerialNumber = identities.at(-1).device;
    entries[0].fileId = identities.at(-1).file;
    entries[0].verifiedVolumeSerialNumber = identities.at(-1).device;
    entries[0].verifiedFileId = identities.at(-1).file;
  } else if (mode === "index-mismatch") entries[0].index += 1;
  else if (mode === "kind-mismatch") entries[0].kind = entries[0].kind === "file" ? "directory" : "file";
  else if (mode === "authority-kind-mismatch") entries[0].authorityKind = entries[0].authorityKind === "root" ? "data" : "root";
  else if (mode === "identity-mismatch") {
    entries[0].fileId = (BigInt(entries[0].fileId) + 1n).toString(10);
  } else if (mode === "sid-mismatch" && entries.length > 1) {
    entries[1].currentUserSid = "S-1-5-21-100-200-300-1002";
  } else if (mode === "broad-write") {
    entries.find((entry) => ["root", "data", "env"].includes(entry.authorityKind)).rules = [{
      identitySid: "S-1-1-0", inherited: false, accessType: "allow", appliesToSelf: true, rights: "2",
    }];
  } else if (mode === "inherited-write") {
    entries.find((entry) => ["root", "data", "env"].includes(entry.authorityKind)).rules[0].inherited = true;
  } else if (mode === "unprotected") {
    entries.find((entry) => ["root", "data", "env"].includes(entry.authorityKind)).daclProtected = false;
  } else if (mode === "owner-mismatch") {
    entries.find((entry) => ["root", "data", "env"].includes(entry.authorityKind)).ownerSid = "S-1-5-18";
  } else if (mode === "reparse") {
    entries.find((entry) => ["root", "data", "env"].includes(entry.authorityKind)).reparsePoint = true;
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
      writeFileSync(envPath, "PROPR_STACK=private-path-SENTINEL\n");
      try {
        return originalSpawnSync(command, args, options);
      } finally {
        rmSync(envPath, { force: true });
        renameSync(detached, envPath);
      }
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
