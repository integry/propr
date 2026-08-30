#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  process.stderr.write("Packed Windows Connect smoke requires Windows.\n");
  process.exit(1);
}

const repo = resolve(import.meta.dirname, "..");
const stage = join(repo, "dist-publish", "propr-cli");
const fixture = mkdtempSync(join(tmpdir(), "propr-packed-connect-"));
const packDirectory = join(fixture, "pack");
const installDirectory = join(fixture, "install");
const runtimeDirectory = join(fixture, "runtime");
const root = join(runtimeDirectory, "stack");
const data = join(root, "data");
const envFile = join(root, ".env");
const endpoint = "https://t-packedfixture.propr.dev";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function installedPath(...parts) {
  return join(installDirectory, "node_modules", "propr-cli", ...parts);
}

function invoke(loader, extraEnvironment = {}) {
  return spawnSync(process.execPath, [
    "--import", loader,
    installedPath("dist", "index.js"),
    "connect", "status", "--json", "--root", root,
  ], {
    cwd: runtimeDirectory,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 8 * 1024,
    env: {
      PATH: join(runtimeDirectory, "bin"),
      PATHEXT: process.env.PATHEXT,
      SYSTEMROOT: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.ComSpec,
      USERPROFILE: process.env.USERPROFILE,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
      // Deliberately unavailable: installed discovery must not compile or use a
      // writable compiler workspace at runtime.
      TEMP: join(runtimeDirectory, "missing-compiler-temp"),
      TMP: join(runtimeDirectory, "missing-compiler-temp"),
      PROPR_WINDOWS_AUTHORITY_VALIDATION: "1",
      ...extraEnvironment,
    },
  });
}

try {
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(installDirectory, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(runtimeDirectory, "bin"), { recursive: true });
  writeFileSync(envFile, [
    "PROPR_STACK=packedfixture",
    "PROPR_INSTANCE_ID=packedfixture",
    `PROPR_UI_PUBLIC_API_URL=${endpoint}`,
    "PROPR_UI_TUNNEL_ENABLED=true",
    "",
  ].join("\n"));

  const packOutput = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDirectory, stage], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }));
  assert.equal(Array.isArray(packOutput), true);
  assert.equal(packOutput.length, 1);
  const packed = packOutput[0];
  assert.equal(typeof packed.filename, "string");
  assert.equal(Array.isArray(packed.files), true);
  const paths = packed.files.map((item) => item.path);
  assert.equal(paths.includes("package.json"), true);
  assert.equal(paths.includes("dist/native/prebuilds/win32-anycpu/connect-authority-supervisor.exe"), true);
  assert.equal(paths.includes("dist/native/prebuilds/win32-anycpu/connect-authority-supervisor.manifest.json"), true);
  assert.equal(paths.includes("dist/native/prebuilds/win32-anycpu/connect-authority-supervisor.manifest.sig"), true);
  assert.equal(paths.includes("dist/native/prebuilds/win32-x64/connect-authority-broker.exe"), true);
  assert.equal(paths.every((path) => path === "README.md" || path === "package.json" || path.startsWith("dist/")), true);
  assert.equal(paths.some((path) => path.endsWith(".map") || path.endsWith(".d.ts")), false);
  const tarball = join(packDirectory, packed.filename);
  const tarballBytes = readFileSync(tarball);
  assert.equal(createHash("sha512").update(tarballBytes).digest("base64"), packed.integrity.replace(/^sha512-/, ""));
  const tarEntries = run("tar", ["-tf", tarball], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
    .split(/\r?\n/u).filter(Boolean);
  assert.equal(tarEntries.every((entry) => entry.startsWith("package/") && !entry.includes("../")), true);
  assert.deepEqual(tarEntries.filter((entry) => !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length)).sort(), [...paths].sort());
  const manifest = JSON.parse(readFileSync(join(stage, "dist", "native", "prebuilds", "win32-anycpu", "connect-authority-supervisor.manifest.json"), "utf8"));
  assert.equal(createHash("sha256").update(readFileSync(join(stage, "dist", "native", "prebuilds", "win32-anycpu", "connect-authority-supervisor.exe"))).digest("hex"), manifest.helperSha256);
  assert.equal(createHash("sha256").update(readFileSync(join(stage, "dist", "native", "prebuilds", "win32-x64", "connect-authority-broker.exe"))).digest("hex"), manifest.launcherSha256);

  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball], {
    cwd: runtimeDirectory,
  });
  const installedManifest = JSON.parse(readFileSync(installedPath(
    "dist", "native", "prebuilds", "win32-anycpu", "connect-authority-supervisor.manifest.json",
  ), "utf8"));
  assert.deepEqual(installedManifest, manifest);
  assert.equal(createHash("sha256").update(readFileSync(installedPath(
    "dist", "native", "prebuilds", "win32-anycpu", "connect-authority-supervisor.exe",
  ))).digest("hex"), manifest.helperSha256);
  assert.equal(createHash("sha256").update(readFileSync(installedPath(
    "dist", "native", "prebuilds", "win32-x64", "connect-authority-broker.exe",
  ))).digest("hex"), manifest.launcherSha256);
  const authority = await import(pathToFileURL(installedPath("dist", "connectRootAuthority.js")).href);
  await authority.protectWindowsSetupEntries([
    { path: runtimeDirectory, kind: "directory" },
    { path: root, kind: "directory" },
    { path: data, kind: "directory" },
    { path: envFile, kind: "file" },
  ]);
  const identityModule = await import(pathToFileURL(installedPath("dist", "connectIdentity.js")).href);
  const identity = await identityModule.getOrCreatePublicInstanceIdentity(data);
  await authority.closeWindowsAuthorityCapability({ requireGracefulShutdown: true });

  const loader = join(runtimeDirectory, "connect-fixture.mjs");
  writeFileSync(loader, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawn=childProcess.spawn;
const originalSpawnSync=childProcess.spawnSync;
const forbidden=(command)=>/(?:^|[\\\\/])(?:powershell|pwsh|csc|cl)(?:\\.exe)?$/i.test(String(command));
childProcess.spawn=(command,...args)=>{if(forbidden(command))throw new Error('forbidden runtime tool');return originalSpawn(command,...args)};
childProcess.spawnSync=(command,args,options)=>{
  if(forbidden(command))throw new Error('forbidden runtime tool');
  return command==='docker'
    ? {pid:1,output:[],stdout:'packedfixture-tunnel\\trunning\\tUp 1 second\\t\\n',stderr:'',status:0,signal:null,error:undefined}
    : originalSpawnSync(command,args,options);
};
syncBuiltinESMExports();
const body=${JSON.stringify({
    schemaVersion: 1,
    product: "ProPR",
    canonicalEndpoint: endpoint,
    publicInstanceIdentity: identity,
    version: "0.8.15",
    apiCompatibility: "2026-06-27",
    uiCompatibility: "2026-06-27",
    desktopAuthentication: {
      protocolVersion: 1,
      browserPairing: true,
      instanceBearerTokens: true,
      socketIoBearerAuthentication: true,
    },
  })};
globalThis.fetch=async(url,options)=>{
  if(String(url)!==${JSON.stringify(`${endpoint}/api/desktop/discovery`)}
    ||options?.redirect!=='manual'||options?.headers?.Accept!=='application/json')throw new Error('invalid discovery request');
  return new Response(JSON.stringify(body),{headers:{
    'content-type':'application/json','cache-control':'no-store, max-age=0',
  }});
};
`);
  const successful = invoke(loader);
  assert.equal(successful.status, 0, successful.stderr);
  assert.equal(successful.stderr, "");
  const document = JSON.parse(successful.stdout);
  assert.deepEqual(document, {
    schemaVersion: 1,
    status: "ready",
    canonicalEndpoint: endpoint,
    publicInstanceIdentity: identity,
    configured: true,
    enabled: true,
    sidecarRunning: true,
    apiReady: true,
    restartRequired: false,
    compatibility: "2026-06-27",
    version: "0.8.15",
    reasonCodes: [],
  });

  const helper = installedPath("dist", "native", "prebuilds", "win32-anycpu", "connect-authority-supervisor.exe");
  const saved = `${helper}.saved`;
  renameSync(helper, saved);
  const missing = invoke(loader);
  assert.notEqual(missing.status, 0);
  assert.equal(`${missing.stdout}${missing.stderr}`.toLowerCase().includes("csc"), false);
  assert.equal(`${missing.stdout}${missing.stderr}`.toLowerCase().includes("powershell"), false);
  renameSync(saved, helper);
  copyFileSync(helper, saved);
  const bytes = readFileSync(helper);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(helper, bytes);
  const tampered = invoke(loader);
  assert.notEqual(tampered.status, 0);
  assert.equal(`${tampered.stdout}${tampered.stderr}`.toLowerCase().includes("csc"), false);
  rmSync(helper, { force: true });
  renameSync(saved, helper);
  copyFileSync(helper, saved);
  copyFileSync(installedPath("dist", "native", "prebuilds", "win32-x64", "connect-authority-broker.exe"), helper);
  const wrongTarget = invoke(loader);
  assert.notEqual(wrongTarget.status, 0);
  assert.equal(`${wrongTarget.stdout}${wrongTarget.stderr}`.toLowerCase().includes("csc"), false);
  rmSync(helper, { force: true });
  renameSync(saved, helper);
  process.stdout.write("Packed Windows Connect smoke: PASS\n");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
