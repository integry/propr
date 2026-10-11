import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { createPreviewPackage, readPreviewOptions, validatePreviewInput, validatePreviewSource,
  verifyPreviewInput, writePreviewEvidence } from '../packages/cli/scripts/preview-package.mjs';
import { buildStandalonePackage } from '../packages/cli/scripts/build-publish.mjs';
import { smokePreviewPackage } from '../packages/cli/scripts/smoke-preview-package.mjs';
import { sha256File } from '../scripts/preview-runtime-images.mjs';

const source = 'a'.repeat(40);
const digest = char => `sha256:${char.repeat(64)}`;
const input = () => ({ schemaVersion: 1, repository: 'integry/propr', sourceRevision: source,
  images: Object.fromEntries(['app', 'ui', 'agent'].map(image => [image, `propr/${image}:${source}@${digest('f')}`])) });

// In-memory registry with native config labels, exercising the shared verifier.
function registryFixture(change = () => {}) {
  const calls = [];
  const registry = args => {
    calls.push(args);
    const image = args[2].match(/propr\/(app|ui|agent)/)?.[1];
    const architecture = args[2].includes(digest('b')) || args[3] === digest('d') ? 'arm64' : 'amd64';
    let value;
    if (args[0] === 'image' && args[1] === 'digest') return digest('f');
    if (args[0] === 'manifest' && args[1] === 'get') {
      value = args[2].includes(`@${digest('f')}`) ? {
        manifests: (image === 'agent' ? ['amd64'] : ['amd64', 'arm64']).map((arch, i) => ({
          digest: digest(i ? 'b' : 'a'), platform: { os: 'linux', architecture: arch },
        })),
      } : { config: { digest: digest(architecture === 'arm64' ? 'd' : 'c') } };
    } else if (args[0] === 'blob' && args[1] === 'get') {
      value = { os: 'linux', architecture, config: { Labels: {
        'org.opencontainers.image.source': 'https://github.com/integry/propr',
        'org.opencontainers.image.revision': source, 'dev.propr.agent-bundle': 'true',
        ...Object.fromEntries(['claude', 'codex', 'antigravity', 'opencode', 'vibe'].map(cli => [`dev.propr.agent.${cli}.version`, '1.0.0'])),
        'dev.propr.agent-tank.version': '1.0.0',
      } } };
    } else throw new Error(`Unexpected registry operation ${args}`);
    change(value, args, image);
    return JSON.stringify(value);
  };
  return { registry, calls };
}

test('preview rejects mutable refs, wrong scope, malformed digests and source mismatches', () => {
  for (const edit of [
    x => { x.sourceRevision = source.slice(0, 12); },
    x => { x.sourceRevision = source.toUpperCase(); },
    x => { x.repository = 'other/propr'; },
    x => { x.images.docs = x.images.app; },
    x => { delete x.images.agent; },
    x => { x.images.app = `propr/app:latest@${digest('f')}`; },
    x => { x.images.ui = 'propr/ui:beta'; },
    x => { x.images.agent = `other/agent:${source}@${digest('f')}`; },
    x => { x.images.app += '\n'; },
    x => { x.images.app = `propr/app:${'b'.repeat(40)}@${digest('f')}`; },
    x => { x.images.app = `propr/app:${source}@sha256:1234`; },
  ]) {
    const value = input(); edit(value);
    assert.throws(() => validatePreviewInput(value));
  }
});

test('shared verifier checks every platform config and permits only registry reads', () => {
  const { registry, calls } = registryFixture();
  const verified = verifyPreviewInput(input(), registry);
  assert.deepEqual(verified.agent.platforms, ['linux/amd64']);
  assert.deepEqual(verified.app.platforms, verified.ui.platforms);
  assert.ok(calls.every(args => ['manifest get', 'blob get', 'image digest'].includes(args.slice(0, 2).join(' '))));
});

test('digest, source label, repository label, bundle and architecture mismatches fail closed', () => {
  for (const mutate of [
    (v, args, image) => { if (image === 'app' && v.config?.Labels) v.config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40); },
    v => { if (v.config?.Labels) v.config.Labels['org.opencontainers.image.source'] = 'https://github.com/other/propr'; },
    (v, args, image) => { if (image === 'agent' && v.config?.Labels) delete v.config.Labels['dev.propr.agent-bundle']; },
    (v, args, image) => { if (image === 'ui' && v.manifests) v.manifests.pop(); },
    (v, args, image) => { if (image === 'agent' && v.manifests) v.manifests[0].platform.architecture = 'arm64'; },
    v => { if (v.manifests) v.manifests[0].digest = 'sha256:bad'; },
    v => { if (v.config?.Labels) v.architecture = 's390x'; },
  ]) assert.throws(() => verifyPreviewInput(input(), registryFixture(mutate).registry));
  const { registry } = registryFixture();
  assert.throws(() => verifyPreviewInput(input(), args => args[0] === 'image' ? digest('e') : registry(args)), /digest mismatch/);
});

test('version deterministically binds all three image digests without changing source versions', () => {
  const fixture = input();
  const verified = verifyPreviewInput(fixture, registryFixture().registry);
  const preview = createPreviewPackage('0.9.0', fixture, verified);
  assert.match(preview.version, new RegExp(`^0.9.0-preview.${source}.[a-f0-9]{64}$`));
  assert.deepEqual(createPreviewPackage('0.9.0', fixture, verified), preview);
  fixture.images.agent = fixture.images.agent.replace(digest('f'), digest('e'));
  assert.notEqual(createPreviewPackage('0.9.0', fixture, verified).version, preview.version);
  assert.equal(preview.manifest.images.docs, undefined, 'No stable docs fallback');
});

test('preview mode cannot publish, accept unknown arguments or skip source trust', () => {
  assert.equal(readPreviewOptions([], '.'), undefined);
  assert.equal(readPreviewOptions(['--publish'], '.'), undefined);
  for (const args of [['--preview-input', 'x', '--publish'], ['--preview-input', 'x'], ['--unknown', 'x'],
    ['--preview-input', 'x', '--preview-input', 'y']]) assert.throws(() => readPreviewOptions(args, '.'));
  assert.throws(() => validatePreviewSource(input(), 'main', '.'), /full lowercase SHA/);
});

test('source preparation gates enforce canonical main, ancestry, exact checkout, cleanliness and CI dispatch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'preview-cli-git-fixture-'));
  const previousPath = process.env.PATH;
  try {
    const statePath = join(directory, 'state.json');
    const executable = join(directory, 'git');
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'merge-base') process.exit(state.ancestor ? 0 : 1);
const key = args[0] === 'remote' ? 'origin' : args[0] === 'status' ? 'dirty'
  : args[1] === 'HEAD' ? 'head' : 'main';
process.stdout.write(state[key]);
`);
    chmodSync(executable, 0o755);
    process.env.PATH = `${directory}${delimiter}${previousPath}`;
    const good = { origin: 'https://github.com/integry/propr.git', head: source,
      main: source, ancestor: true, dirty: '' };
    const check = (state, env = {}) => {
      writeFileSync(statePath, JSON.stringify(state));
      return validatePreviewSource(input(), source, process.cwd(), env);
    };
    check(good);
    for (const bad of [{ origin: 'https://github.com/other/propr.git' }, { main: 'b'.repeat(40) },
      { head: 'b'.repeat(40) }, { ancestor: false }, { dirty: ' M packages/cli/src/index.ts' },
      { dirty: '?? packages/cli/src/unreviewed.ts' }]) assert.throws(() => check({ ...good, ...bad }));
    const ci = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'integry/propr',
      GITHUB_REF: 'refs/heads/main', GITHUB_SHA: source, GITHUB_EVENT_NAME: 'workflow_dispatch' };
    check(good, ci);
    for (const bad of [{ GITHUB_REPOSITORY: 'other/propr' }, { GITHUB_REF: 'refs/heads/feature' },
      { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_EVENT_NAME: 'pull_request' }]) {
      assert.throws(() => check(good, { ...ci, ...bad }), /CI preparation/);
    }
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('standalone stable and preview tarballs install and select their exact bundled manifests', { skip: process.env.PROPR_CLI_PACKAGE_SMOKE !== '1', timeout: 240000 }, async () => {
  const files = ['package.json', 'package-lock.json', 'packages/cli/package.json', 'docker/launcher/manifest.json'];
  const before = files.map(file => readFileSync(file, 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'preview-cli-test-'));
  try {
    // Build the established stable default first, then stage synthetic preview
    // bindings using the same public builder. No live registry or source bypass
    // flag exists in the operator command.
    const stable = await buildStandalonePackage();
    const version = JSON.parse(before[2]).version;
    const stableManifest = JSON.parse(readFileSync(join(stable.stageDir, 'dist/orchestrator/manifest.json'), 'utf8'));
    assert.equal(stable.stagePkg.version, version);
    for (const image of ['app', 'ui', 'agent', 'docs']) assert.equal(stableManifest.images[image], `propr/${image}:${version}`);
    const pack = stageDir => JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: stageDir, encoding: 'utf8' }))[0].filename;
    await smokePreviewPackage(join(directory, pack(stable.stageDir)), { version, manifest: stableManifest });
    const preview = createPreviewPackage(version, input(), verifyPreviewInput(input(), registryFixture().registry));
    const staged = await buildStandalonePackage(preview);
    const tarball = pack(staged.stageDir);
    const smoke = await smokePreviewPackage(join(directory, tarball), preview);
    const evidence = writePreviewEvidence(directory, tarball, preview, source, smoke);
    assert.equal(evidence.files[tarball], sha256File(join(directory, tarball)));
    assert.equal(evidence.files['manifest.json'], smoke.manifestSha256);
    execFileSync('sha256sum', ['--check', 'SHA256SUMS'], { cwd: directory });
    writeFileSync(join(directory, tarball), 'tampered');
    assert.throws(() => execFileSync('sha256sum', ['--check', 'SHA256SUMS'], { cwd: directory, stdio: 'pipe' }));
    assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
