import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  throw new Error('Packaged Connect discovery smoke requires Darwin or Windows');
}
if (process.arch !== 'x64' && process.arch !== 'arm64') {
  throw new Error('Packaged Connect discovery smoke requires x64 or arm64');
}

const artifactRoot = resolve('out', `propr-desktop-${process.platform}-${process.arch}`);
const binaryPath = process.platform === 'darwin'
  ? join(artifactRoot, 'propr-desktop.app', 'Contents', 'MacOS', 'propr-desktop')
  : join(artifactRoot, 'propr-desktop.exe');
const resourcesPath = process.platform === 'darwin'
  ? join(artifactRoot, 'propr-desktop.app', 'Contents', 'Resources')
  : join(artifactRoot, 'resources');
const unpackedNative = join(resourcesPath, 'app.asar.unpacked', '.vite', 'native', 'prebuilds');
const readyEvent = 'desktop.renderer.connect_discovery.ready';
const endpoint = 'https://t-packaged123.propr.dev';
const identity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secrets = [
  'tunnel-secret-SENTINEL', 'connector-secret-SENTINEL',
  'relay-secret-SENTINEL', 'github-secret-SENTINEL',
];
const darwinHashes = {
  arm64: {
    'connect-authority-broker': '75fda2624bf093555e726b968401321fef61ea7ae0479f4c1892be0dfc6554c0',
    'directory-operations.node': '88f07c0c7a4371f4fb227a4691009d09517de582ba49297d28d03ac94e586615',
  },
  x64: {
    'connect-authority-broker': 'e5a49be0db85655b9ff1d0614de9d61defd41a0a1b2eff8f11571407f10d809b',
    'directory-operations.node': '62183c0f4083cb8c98e09e2d2c688f8f81703e12b0f22320c335b51e927eaf53',
  },
};

const assertCanonicalParents = async candidate => {
  let parent = dirname(candidate);
  while (true) {
    const named = await lstat(parent);
    if (!named.isDirectory() || named.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new Error('Packaged native candidate has noncanonical parent ancestry');
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
};

const assertPackageAuthority = async () => {
  if (process.platform === 'win32') {
    try {
      await lstat(unpackedNative);
      throw new Error('Windows package unexpectedly contains an unused native authority helper');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  const selected = join(unpackedNative, `darwin-${process.arch}`);
  for (const [name, expected] of Object.entries(darwinHashes[process.arch])) {
    const candidate = join(selected, name);
    await assertCanonicalParents(candidate);
    const named = await lstat(candidate);
    if (!named.isFile()
      || named.isSymbolicLink()
      || (named.mode & 0o022) !== 0
      || (name === 'connect-authority-broker' && (named.mode & 0o111) === 0)) {
      throw new Error('Packaged Darwin native authority artifact failed type or mode verification');
    }
    const digest = createHash('sha256').update(await readFile(candidate)).digest('hex');
    if (digest !== expected) throw new Error('Packaged Darwin native authority artifact failed integrity verification');
  }
  const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  try {
    await lstat(join(unpackedNative, `darwin-${otherArch}`));
    throw new Error('Darwin package contains the unselected architecture authority artifacts');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

const protectWindowsEntries = paths => {
  const membership = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Out.Write(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))',
  ], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  if (membership.status !== 0 || membership.stdout !== 'False') {
    throw new Error('Packaged Windows Connect discovery must run as an ordinary user');
  }
  const source = String.raw`
$ErrorActionPreference='Stop'
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
foreach($path in $args){
  $directory=(Get-Item -LiteralPath $path).PSIsContainer
  $acl=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
  $acl.SetOwner($current);$acl.SetAccessRuleProtection($true,$false)
  foreach($identity in @($current,$system,$admins)){
    $rule=if($directory){
      [Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    }else{[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow')}
    $null=$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source, ...paths], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000,
  });
  if (result.status !== 0 || result.error || result.signal || result.stderr) {
    throw new Error('Could not prepare the ordinary-user Windows authority fixture');
  }
};

const canonicalTemp = await realpath(tmpdir());
const fixture = await mkdtemp(join(canonicalTemp, 'propr-desktop-connect-smoke-'));
const configRoot = join(fixture, 'config');
const stackRoot = join(fixture, 'stack-private-path-SENTINEL');
const dataRoot = join(stackRoot, 'data');
const identityPath = join(dataRoot, 'public-instance-identity.json');
const envPath = join(stackRoot, '.env');
const configPath = join(configRoot, 'config.json');
const userDataPath = join(fixture, 'desktop-user-data');

try {
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify({ stackRoot })}\n`, { mode: 0o600 });
  await writeFile(envPath, [
    'PROPR_STACK=packaged-connect-smoke',
    'PROPR_INSTANCE_ID=packaged123',
    `PROPR_UI_PUBLIC_API_URL=${endpoint}`,
    'PROPR_UI_TUNNEL_ENABLED=true',
    `PROPR_UI_TUNNEL_TOKEN=${secrets[0]}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(identityPath, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: identity })}\n`, { mode: 0o600 });
  if (process.platform === 'darwin') {
    await Promise.all([
      chmod(fixture, 0o700), chmod(configRoot, 0o700), chmod(stackRoot, 0o700),
      chmod(dataRoot, 0o700), chmod(userDataPath, 0o700), chmod(configPath, 0o600),
      chmod(envPath, 0o600), chmod(identityPath, 0o600),
    ]);
  } else {
    protectWindowsEntries([stackRoot, dataRoot, envPath, identityPath]);
  }
  await assertPackageAuthority();

  let output = '';
  const child = spawn(binaryPath, ['--disable-gpu', `--user-data-dir=${userDataPath}`], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PROPR_DESKTOP_CONNECT_SMOKE_TEST: '1',
      PROPR_DESKTOP_CONNECT_SMOKE_CONFIG_ROOT: configRoot,
      PROPR_CONNECTOR_TOKEN: secrets[1],
      PROPR_RELAY_TOKEN: secrets[2],
      GITHUB_TOKEN: secrets[3],
    },
  });
  const capture = chunk => { output += chunk.toString(); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const result = await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL'); reject(new Error('Packaged Connect discovery smoke timed out'));
    }, 300_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout); resolveResult({ code, signal });
    });
  });
  if (result.code !== 0 || result.signal) throw new Error('Packaged Connect discovery app failed');
  const records = output.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line.slice(line.indexOf('{')))]; } catch { return []; }
  });
  const proof = records.find(record => record.event === readyEvent);
  const expectedMechanism = process.platform === 'darwin' ? 'packaged-broker' : 'inherited-standard-handle';
  if (!proof
    || proof.selectedPlatform !== process.platform
    || proof.selectedArch !== process.arch
    || proof.authorityMechanism !== expectedMechanism
    || proof.rendererSchemaValid !== true) throw new Error('Packaged Connect discovery proof was incomplete');
  for (const sentinel of [...secrets, fixture, stackRoot, identity, 'S-1-5-', 'volumeSerialNumber', 'fileId', 'authorityDiagnostic']) {
    if (output.includes(sentinel)) throw new Error('Packaged Connect discovery output leaked secret, path, or native evidence');
  }
  if (relative(canonicalTemp, configRoot).startsWith('..')) throw new Error('Connect smoke config escaped its fixed root');
  process.stdout.write(`Packaged Connect discovery passed for ${process.platform}-${process.arch}: ${expectedMechanism}.\n`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
