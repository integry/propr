import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  inspectAnyCpuPe,
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
  const root = await mkdtemp(join(tmpdir(), 'propr-packaged-helper-'));
  const executable = join(root, 'propr-windows-authority.exe');
  const manifestPath = join(root, 'propr-windows-authority.manifest.json');
  try {
    const bytes = managedPe();
    await writeFile(executable, bytes);
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
      compiler: { kind: 'systemroot-dotnet-framework-csc', framework: 'Framework64-v4.0.30319' },
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
