#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  process.stderr.write("Standard-user Windows Connect proof requires Windows.\n");
  process.exit(1);
}

const expectedUser = process.argv[2];
const actualUser = userInfo().username;
assert.ok(expectedUser && actualUser.toLowerCase() === expectedUser.toLowerCase(), "proof did not run as the limited user");
process.env.PROPR_WINDOWS_AUTHORITY_VALIDATION = "1";

const repo = resolve(import.meta.dirname, "..");
const fixture = mkdtempSync(join(tmpdir(), "propr-standard-user-connect-"));
const root = join(fixture, "stack");
const data = join(root, "data");
const bin = join(fixture, "bin");
const endpoint = "https://t-standarduser.propr.dev";
const identity = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

try {
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, ".env"), [
    "PROPR_STACK=packedfixture",
    "PROPR_INSTANCE_ID=standarduser",
    `PROPR_UI_PUBLIC_API_URL=${endpoint}`,
    "PROPR_UI_TUNNEL_ENABLED=true",
    "",
  ].join("\n"));
  writeFileSync(join(data, "public-instance-identity.json"), `${JSON.stringify({
    schemaVersion: 1,
    publicInstanceIdentity: identity,
  })}\n`);
  copyFileSync(join(repo, "scripts", "fixtures", "windows-connect-docker-fixture.exe"), join(bin, "docker.exe"));
  writeFileSync(join(bin, "fixture-mode.txt"), "missing");

  const guard = join(fixture, "status-no-packaged-native.mjs");
  writeFileSync(guard, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawn=childProcess.spawn;
const originalSpawnSync=childProcess.spawnSync;
const forbidden=(command)=>/(?:connect-authority-(?:broker|bootstrap|supervisor)|ProPRConnectAuthority)(?:\\.exe)?$/i.test(String(command));
childProcess.spawn=(command,...args)=>{if(forbidden(command))throw new Error('packaged native execution forbidden');return originalSpawn(command,...args)};
childProcess.spawnSync=(command,args,options)=>{if(forbidden(command))throw new Error('packaged native execution forbidden');return originalSpawnSync(command,args,options)};
syncBuiltinESMExports();
`);
  const status = spawnSync(process.execPath, [
    join(repo, "packages", "cli", "dist", "index.js"),
    "connect", "status", "--json", "--root", root,
  ], {
    cwd: fixture,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 8 * 1024,
    env: {
      PATH: bin,
      PATHEXT: process.env.PATHEXT,
      SYSTEMROOT: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.ComSpec,
      USERPROFILE: process.env.USERPROFILE,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
      NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
    },
  });
  assert.equal(status.status, 0, status.stderr);
  const document = JSON.parse(status.stdout);
  assert.equal(document.status, "notReady");
  assert.equal(document.canonicalEndpoint, endpoint);
  assert.equal(document.publicInstanceIdentity, identity);
  assert.deepEqual(document.reasonCodes, ["SIDECAR_NOT_RUNNING", "ACL_DIAGNOSTIC_UNAVAILABLE"]);

  const authority = await import(pathToFileURL(join(repo, "packages", "cli", "dist", "connectRootAuthority.js")).href);
  const proof = await authority.exerciseWindowsAuthorityCapabilityForNativeTest();
  assert.deepEqual(JSON.parse(proof.output.toString("utf8")), { version: 1, ready: true });
  assert.ok(proof.authorityPid > 0 && proof.supervisorPid > 0);
  await authority.closeWindowsAuthorityCapability({ requireGracefulShutdown: true });
  process.stdout.write(`Windows standard-user Connect proof: user=${actualUser} status=PASS service=PASS\n`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
