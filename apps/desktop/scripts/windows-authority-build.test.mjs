import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  inspectAnyCpuPe,
  decodeWindowsSystemDirectoryRecord,
  resolveWindowsCompilerLayout,
  validateWindowsAuthoritySource,
  WINDOWS_AUTHORITY_SOURCE,
} from './build-windows-authority-helper.mjs';
import {
  inspectPackagedWindowsAuthority,
  refreshPackagedWindowsAuthorityManifest,
} from './inspect-packaged-windows-authority.mjs';

const managedPe = () => {
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x14c, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(224, 0x94);
  bytes.writeUInt16LE(0x10b, 0x98);
  bytes.writeUInt32LE(0x2000, 0x98 + 96 + (14 * 8));
  bytes.writeUInt32LE(72, 0x98 + 96 + (14 * 8) + 4);
  bytes.writeUInt32LE(0x200, 0x178 + 8);
  bytes.writeUInt32LE(0x2000, 0x178 + 12);
  bytes.writeUInt32LE(0x200, 0x178 + 16);
  bytes.writeUInt32LE(0x200, 0x178 + 20);
  bytes.writeUInt32LE(0x1, 0x210);
  return bytes;
};

const systemDirectoryRecord = path => {
  const output = Buffer.alloc(2 + (520 * 2));
  output.writeUInt16LE(path.length, 0);
  output.write(path, 2, 'utf16le');
  return output;
};

test('bounded Windows system-directory channel rejects NT aliases, malformed records, and trailing data', () => {
  assert.equal(decodeWindowsSystemDirectoryRecord(systemDirectoryRecord('C:\\Windows')), 'C:\\Windows');
  assert.throws(() => decodeWindowsSystemDirectoryRecord(systemDirectoryRecord('\\\\?\\GLOBALROOT\\SystemRoot')), /BUILD_COMPILER/);
  assert.throws(() => decodeWindowsSystemDirectoryRecord(Buffer.alloc(8)), /BUILD_COMPILER/);
  const trailing = systemDirectoryRecord('C:\\Windows');
  trailing[trailing.length - 1] = 1;
  assert.throws(() => decodeWindowsSystemDirectoryRecord(trailing), /BUILD_COMPILER/);
});

test('compiler layout treats SystemRoot and windir as disagreement checks and rejects reparse references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-system-directory-'));
  try {
    const framework = join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    await mkdir(framework, { recursive: true });
    for (const name of ['csc.exe', 'System.dll', 'System.Web.Extensions.dll']) await writeFile(join(framework, name), name);
    await chmod(join(framework, 'csc.exe'), 0o700);
    const exact = await resolveWindowsCompilerLayout({ SystemRoot: root, windir: root }, async () => root);
    assert.equal(exact.systemRoot, await realpath(root));
    await assert.rejects(resolveWindowsCompilerLayout({ SystemRoot: root, windir: join(root, 'fake') }, async () => root),
      /BUILD_COMPILER/);
    await rm(join(framework, 'System.dll'));
    await symlink(join(framework, 'System.Web.Extensions.dll'), join(framework, 'System.dll'));
    await assert.rejects(resolveWindowsCompilerLayout({}, async () => root), /BUILD_COMPILER/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('committed Windows broker source is nonempty strict UTF-8 with a real executable entrypoint', async () => {
  const source = await readFile(WINDOWS_AUTHORITY_SOURCE);
  assert.match(validateWindowsAuthoritySource(source), /^[a-f0-9]{64}$/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.alloc(0)), /BUILD_SOURCE/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.from([0xc3, 0x28])), /BUILD_SOURCE/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.from('public class SourceOnly {}')), /BUILD_SOURCE/);
});

test('compiled helper output gate rejects corrupt, native-only, and wrong-machine PE files', () => {
  const exact = managedPe();
  assert.deepEqual(inspectAnyCpuPe(exact), { format: 'PE32', architecture: 'anycpu', machine: 'I386', clr: true });
  const nativeOnly = Buffer.from(exact);
  nativeOnly.writeUInt32LE(0, 0x98 + 96 + (14 * 8));
  assert.throws(() => inspectAnyCpuPe(nativeOnly), /BUILD_OUTPUT/);
  const wrongMachine = Buffer.from(exact);
  wrongMachine.writeUInt16LE(0xaa64, 0x84);
  assert.throws(() => inspectAnyCpuPe(wrongMachine), /BUILD_OUTPUT/);
  const required32Bit = Buffer.from(exact);
  required32Bit.writeUInt32LE(0x3, 0x210);
  assert.throws(() => inspectAnyCpuPe(required32Bit), /BUILD_OUTPUT/);
});

test('packaged helper refresh and inspection bind the exact held manifest and signed helper bytes', async () => {
  // Darwin aliases /var to /private/var. Establish the fixture below the
  // explicitly held canonical temp root so child proofs use one namespace.
  const trustedTempRoot = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(trustedTempRoot, 'propr-packaged-helper-')));
  const executable = join(root, 'propr-windows-authority.exe');
  const launcherPath = join(root, 'propr-windows-launcher.node');
  const manifestPath = join(root, 'propr-windows-authority.manifest.json');
  try {
    const bytes = managedPe();
    const launcher = Buffer.from(bytes);
    launcher.writeUInt16LE(0x8664, 0x84);
    await writeFile(executable, bytes);
    await writeFile(launcherPath, launcher);
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      name: 'propr-windows-authority.exe',
      format: 'PE32',
      architecture: 'anycpu',
      machine: 'I386',
      clr: true,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceSha256: 'a'.repeat(64),
      protocol: 'propr-windows-authority-v1',
      trust: 'unsigned-validation',
      publisher: null,
      signerPins: [],
      signerCertificateSha256: null,
      signerSpkiSha256: null,
      launcher: {
        name: 'propr-windows-launcher.node',
        format: 'PE',
        architecture: 'x64',
        machine: 'AMD64',
        size: launcher.length,
        sha256: createHash('sha256').update(launcher).digest('hex'),
        trust: 'unsigned-validation',
        publisher: null,
        signerPins: [],
        signerCertificateSha256: null,
        signerSpkiSha256: null,
      },
      compiler: {
        kind: 'kernel-system-directory-probe-dotnet-framework-csc',
        framework: 'Framework64-v4.0.30319',
        inputs: [
          { name: 'csc.exe', size: 1, sha256: 'b'.repeat(64) },
          { name: 'System.dll', size: 1, sha256: 'c'.repeat(64) },
          { name: 'System.Web.Extensions.dll', size: 1, sha256: 'd'.repeat(64) },
        ],
      },
    })}\n`);
    await refreshPackagedWindowsAuthorityManifest(executable, manifestPath, {
      PROPR_DESKTOP_PRODUCTION_RELEASE: '0',
    });
    const manifest = await inspectPackagedWindowsAuthority(executable, manifestPath);
    assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
    const corrupt = Buffer.from(bytes);
    corrupt[700] ^= 1;
    await writeFile(executable, corrupt);
    await assert.rejects(inspectPackagedWindowsAuthority(executable, manifestPath), /inspection failed/);
    await writeFile(executable, bytes);
    const corruptLauncher = Buffer.from(launcher);
    corruptLauncher[700] ^= 1;
    await writeFile(launcherPath, corruptLauncher);
    await assert.rejects(inspectPackagedWindowsAuthority(executable, manifestPath), /inspection failed/);
    const wrongArchitecture = Buffer.from(launcher);
    wrongArchitecture.writeUInt16LE(0xaa64, 0x84);
    await writeFile(launcherPath, wrongArchitecture);
    await assert.rejects(inspectPackagedWindowsAuthority(executable, manifestPath), /inspection failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
