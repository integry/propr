import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

// scripts/check-image-whiteouts.sh guards #3399: a layer with `.wh.` entries
// cannot be unpacked by rootless, userxattr overlay or OrbStack containerd
// snapshotters. These archives mirror both `docker save` layouts: the classic
// store's `<id>/layer.tar` and the containerd store's OCI `blobs/sha256/*`,
// whose layers may be compressed.
const script = resolve('scripts/check-image-whiteouts.sh');
const unsupported = process.platform === 'win32';

function tar(args, cwd) {
  const result = spawnSync('tar', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function makeLayer(root, name, files, { gzip = false } = {}) {
  const tree = join(root, `${name}-tree`);
  for (const file of files) {
    mkdirSync(join(tree, file, '..'), { recursive: true });
    writeFileSync(join(tree, file), '');
  }
  return { tree, gzip };
}

function saveArchive(t, layers, { oci = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'image-whiteouts-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const save = join(root, 'save');
  mkdirSync(save);
  const paths = layers.map((files, index) => {
    const layer = makeLayer(root, `layer${index}`, files.files ?? files, { gzip: Boolean(files.gzip) });
    const path = oci ? `blobs/sha256/${String(index).padStart(64, '0')}` : `${index}/layer.tar`;
    mkdirSync(join(save, path, '..'), { recursive: true });
    tar([layer.gzip ? '-czf' : '-cf', join(save, path), '-C', layer.tree, '.'], root);
    return path;
  });
  writeFileSync(join(save, 'manifest.json'), JSON.stringify([{ Config: 'config.json', RepoTags: ['propr/agent:test'], Layers: paths }]));
  const archive = join(root, 'image.tar');
  tar(['-cf', archive, '-C', save, '.'], root);
  return { root, archive };
}

function check(args, env = {}) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('check-image-whiteouts.sh', { skip: unsupported }, () => {
  test('passes an image whose layers only add paths', (t) => {
    const { archive } = saveArchive(t, [['usr/bin/node', 'etc/ssl/certs/ca.pem'], ['home/node/.gitconfig', 'usr/local/bin/claude']]);
    const result = check(['--archive', archive]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /none of its 2 layers contains an overlayfs whiteout/);
  });

  test('rejects opaque directory markers and reports the layer that carries them', (t) => {
    const { archive } = saveArchive(t, [
      ['usr/bin/node'],
      ['etc/ssl/.wh..wh..opq', 'etc/ssl/openssl.cnf', 'usr/include/linux/.wh..wh..opq'],
    ]);
    const result = check(['--archive', archive]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /layer 1 \(1\/layer\.tar\): 2 whiteout entries \(2 opaque\)/);
    assert.match(result.stderr, /etc\/ssl\/\.wh\.\.wh\.\.opq/);
    assert.doesNotMatch(result.stderr, /layer 0/);
  });

  test('rejects plain deletion whiteouts too, in compressed OCI layout blobs', (t) => {
    const { archive } = saveArchive(t, [
      { files: ['var/lib/apt/lists/auxfiles/x'], gzip: true },
      { files: ['var/lib/apt/lists/.wh.auxfiles'], gzip: true },
    ], { oci: true });
    const result = check(['--archive', archive]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /layer 1 \(blobs\/sha256\/0+1\): 1 whiteout entries \(0 opaque\)/);
    assert.match(result.stderr, /var\/lib\/apt\/lists\/\.wh\.auxfiles/);
  });

  test('does not mistake names that merely contain .wh. for whiteouts', (t) => {
    const { archive } = saveArchive(t, [['opt/app/file.wh.txt', 'opt/a.wh.b/c']]);
    const result = check(['--archive', archive]);
    assert.equal(result.status, 0, result.stderr);
  });

  test('reads the image through docker save', (t) => {
    const { root, archive } = saveArchive(t, [['etc/gss/.wh..wh..opq']]);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\n[ "$1" = save ] && [ "$2" = propr/agent:test ] || exit 9\nexec cat "${archive}"\n`, { mode: 0o755 });
    const result = check(['propr/agent:test'], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /propr\/agent:test contains overlayfs whiteouts/);
  });

  test('refuses manifests that point outside the saved image', (t) => {
    const { root } = saveArchive(t, [['usr/bin/node']]);
    const save = join(root, 'save');
    writeFileSync(join(save, 'manifest.json'), JSON.stringify([{ Layers: ['../escape.tar'] }]));
    const archive = join(root, 'escape.tar');
    tar(['-cf', archive, '-C', save, '.'], root);
    const result = check(['--archive', archive]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe layer path/);
  });

  test('requires exactly one image or archive argument', () => {
    assert.equal(check([]).status, 2);
    assert.equal(check(['--archive']).status, 2);
    assert.equal(check(['a', 'b']).status, 2);
  });
});
