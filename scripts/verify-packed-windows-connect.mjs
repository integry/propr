#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
const certificate = join(repo, "scripts", "fixtures", "packed-connect-cert.fixture");
const privateKey = join(repo, "scripts", "fixtures", "packed-connect-key.b64");
let sidecar;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding,
    timeout: options.timeout ?? 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function installedPath(...parts) {
  return join(installDirectory, "node_modules", "propr-cli", ...parts);
}

function invoke(extraEnvironment = {}) {
  const entrypoint = join(installDirectory, "node_modules", ".bin", "propr.cmd");
  assert.equal(statSync(entrypoint).isFile(), true, "npm did not install the public propr bin shim");
  return spawnSync(process.env.ComSpec, ["/d", "/s", "/c",
    `"${entrypoint}" connect status --json --root "${root}"`,
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
      NODE_EXTRA_CA_CERTS: certificate,
      NODE_OPTIONS: `--require=${join(runtimeDirectory, "connect-dns.cjs")} --import=${pathToFileURL(join(runtimeDirectory, "connect-guard.mjs")).href}`,
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
  assert.equal(paths.includes("dist/native/prebuilds/win32-x64/connect-authority-bootstrap.exe"), true);
  assert.equal(paths.includes("dist/native/prebuilds/win32-service/ProPRConnectAuthority.exe"), true);
  assert.equal(paths.includes("dist/native/prebuilds/win32-service/ProPRConnectAuthority.msi"), true);
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
  assert.equal(createHash("sha256").update(readFileSync(join(stage, "dist", "native", "prebuilds", "win32-x64", "connect-authority-bootstrap.exe"))).digest("hex"), manifest.build.bootstrapSha256);
  assert.equal(createHash("sha256").update(readFileSync(join(stage, "dist", "native", "prebuilds", "win32-service", "ProPRConnectAuthority.exe"))).digest("hex"), manifest.service.imageSha256);
  assert.equal(createHash("sha256").update(readFileSync(join(stage, "dist", "native", "prebuilds", "win32-service", "ProPRConnectAuthority.msi"))).digest("hex"), manifest.service.installerSha256);

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
  assert.equal(createHash("sha256").update(readFileSync(installedPath(
    "dist", "native", "prebuilds", "win32-x64", "connect-authority-bootstrap.exe",
  ))).digest("hex"), manifest.build.bootstrapSha256);
  const installedService = installedPath(
    "dist", "native", "prebuilds", "win32-service", "ProPRConnectAuthority.exe",
  );
  const installedServiceInstaller = installedPath(
    "dist", "native", "prebuilds", "win32-service", "ProPRConnectAuthority.msi",
  );
  assert.equal(createHash("sha256").update(readFileSync(installedService)).digest("hex"), manifest.service.imageSha256);
  assert.equal(createHash("sha256").update(readFileSync(installedServiceInstaller)).digest("hex"), manifest.service.installerSha256);
  run("msiexec.exe", ["/fa", installedServiceInstaller, "/qn", "/norestart"]);
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

  const modeFile = join(runtimeDirectory, "bin", "fixture-mode.txt");
  const dockerFixture = join(runtimeDirectory, "bin", "docker.exe");
  writeFileSync(modeFile, "ready");
  copyFileSync(join(repo, "scripts", "fixtures", "windows-connect-docker-fixture.exe"), dockerFixture);
  const guard = join(runtimeDirectory, "connect-guard.mjs");
  writeFileSync(guard, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawn=childProcess.spawn;
const originalSpawnSync=childProcess.spawnSync;
const forbidden=(command)=>/(?:^|[\\\\/])(?:powershell|pwsh|csc|cl|link)(?:\\.exe)?$/i.test(String(command));
childProcess.spawn=(command,...args)=>{if(forbidden(command))throw new Error('forbidden runtime tool');return originalSpawn(command,...args)};
childProcess.spawnSync=(command,args,options)=>{
  if(forbidden(command))throw new Error('forbidden runtime tool');
  return originalSpawnSync(command,args,options);
};
syncBuiltinESMExports();
`);
  writeFileSync(join(runtimeDirectory, "connect-dns.cjs"), `
const dns=require('node:dns');
const original=dns.lookup;
dns.lookup=function(hostname,options,callback){
  if(hostname!=='t-packedfixture.propr.dev')return original.apply(this,arguments);
  if(typeof options==='function')return options(null,'127.0.0.1',4);
  if(options&&options.all)return callback(null,[{address:'127.0.0.1',family:4}]);
  return callback(null,'127.0.0.1',4);
};
`);
  const discovery = {
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
  };
  const sidecarScript = join(runtimeDirectory, "connect-sidecar.mjs");
  writeFileSync(sidecarScript, `
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
const modeFile=process.argv[2];
const base=${JSON.stringify(discovery)};
const encodedKey=readFileSync(process.argv[4],'ascii').trim();
const key='-----BEGIN PRIVATE KEY-----\\n'+encodedKey+'\\n-----END PRIVATE KEY-----\\n';
const server=createServer({cert:readFileSync(process.argv[3]),key},(request,response)=>{
  if(request.method!=='GET'||request.url!=='/api/desktop/discovery'||request.headers.accept!=='application/json'){
    response.writeHead(404,{'cache-control':'no-store'}).end();return;
  }
  const mode=readFileSync(modeFile,'utf8').trim();
  const body=mode==='tampered'?'{"schemaVersion":2}':JSON.stringify(mode==='wrong-target'
    ?{...base,publicInstanceIdentity:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}
    :mode==='stale'?{...base,canonicalEndpoint:'https://t-stale.propr.dev'}:base);
  response.writeHead(200,{'content-type':'application/json','cache-control':'no-store, max-age=0','content-length':Buffer.byteLength(body)});
  response.end(body);
});
server.listen(443,'127.0.0.1',()=>process.stdout.write('READY\\n'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`);
  sidecar = spawn(process.execPath, [sidecarScript, modeFile, certificate, privateKey], {
    cwd: runtimeDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("Connect sidecar fixture did not start")), 5_000);
    sidecar.once("error", rejectReady);
    sidecar.once("exit", (code) => rejectReady(new Error(`Connect sidecar fixture exited ${code}`)));
    sidecar.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      if (String(chunk) !== "READY\n") rejectReady(new Error("Connect sidecar fixture readiness was malformed"));
      else resolveReady();
    });
  });
  const successful = invoke();
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

  writeFileSync(modeFile, "missing");
  const missingTunnel = invoke();
  assert.equal(missingTunnel.status, 0, missingTunnel.stderr);
  assert.deepEqual(JSON.parse(missingTunnel.stdout).reasonCodes, ["SIDECAR_NOT_RUNNING"]);
  writeFileSync(modeFile, "tampered");
  const tamperedEndpoint = invoke();
  assert.equal(tamperedEndpoint.status, 2, tamperedEndpoint.stderr);
  assert.deepEqual(JSON.parse(tamperedEndpoint.stdout).reasonCodes, ["DISCOVERY_INVALID"]);
  writeFileSync(modeFile, "wrong-target");
  const wrongEndpoint = invoke();
  assert.equal(wrongEndpoint.status, 0, wrongEndpoint.stderr);
  assert.deepEqual(JSON.parse(wrongEndpoint.stdout).reasonCodes, ["IDENTITY_MISMATCH"]);
  writeFileSync(modeFile, "stale");
  const staleEndpoint = invoke();
  assert.equal(staleEndpoint.status, 0, staleEndpoint.stderr);
  assert.deepEqual(JSON.parse(staleEndpoint.stdout).reasonCodes, ["ENDPOINT_MISMATCH", "RESTART_REQUIRED"]);
  writeFileSync(modeFile, "ready");

  const helper = installedPath("dist", "native", "prebuilds", "win32-anycpu", "connect-authority-supervisor.exe");
  const saved = `${helper}.saved`;
  renameSync(helper, saved);
  const missing = invoke();
  assert.notEqual(missing.status, 0);
  assert.equal(`${missing.stdout}${missing.stderr}`.toLowerCase().includes("csc"), false);
  assert.equal(`${missing.stdout}${missing.stderr}`.toLowerCase().includes("powershell"), false);
  renameSync(saved, helper);
  copyFileSync(helper, saved);
  const bytes = readFileSync(helper);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(helper, bytes);
  const tampered = invoke();
  assert.notEqual(tampered.status, 0);
  assert.equal(`${tampered.stdout}${tampered.stderr}`.toLowerCase().includes("csc"), false);
  rmSync(helper, { force: true });
  renameSync(saved, helper);
  copyFileSync(helper, saved);
  copyFileSync(installedPath("dist", "native", "prebuilds", "win32-x64", "connect-authority-broker.exe"), helper);
  const wrongTarget = invoke();
  assert.notEqual(wrongTarget.status, 0);
  assert.equal(`${wrongTarget.stdout}${wrongTarget.stderr}`.toLowerCase().includes("csc"), false);
  rmSync(helper, { force: true });
  renameSync(saved, helper);

  const uninstallMarker = join(runtimeDirectory, "uninstall-request-marker");
  const lifecyclePipe = connect(String.raw`\\.\pipe\ProPR.Connect.Authority.v3`);
  await new Promise((resolveConnected, rejectConnected) => {
    lifecyclePipe.once("connect", resolveConnected);
    lifecyclePipe.once("error", rejectConnected);
  });
  const partialFrame = Buffer.alloc(5);
  partialFrame.writeUInt32LE(128, 0);
  partialFrame[4] = 0x7b;
  lifecyclePipe.write(partialFrame);
  const lifecycleClosed = new Promise((resolveClosed) => lifecyclePipe.once("close", resolveClosed));
  run("msiexec.exe", ["/x", installedServiceInstaller, "/qn", "/norestart"]);
  await lifecycleClosed;
  const absentAuthority = invoke();
  assert.notEqual(absentAuthority.status, 0, "uninstalled authority authorized a package launch");
  assert.equal(existsSync(uninstallMarker), false, "package marker ran during authority uninstall");
  run("msiexec.exe", ["/i", installedServiceInstaller, "/qn", "/norestart"]);
  run("msiexec.exe", ["/fa", installedServiceInstaller, "/qn", "/norestart"]);
  sidecar.kill();
  if (sidecar.exitCode === null) await new Promise((resolveExit) => sidecar.once("exit", resolveExit));
  sidecar = undefined;
  process.stdout.write("Packed Windows Connect smoke: PASS\n");
} finally {
  if (sidecar) {
    sidecar.kill();
    if (sidecar.exitCode === null) await new Promise((resolveExit) => sidecar.once("exit", resolveExit));
  }
  rmSync(fixture, { recursive: true, force: true });
}
