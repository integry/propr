import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  AGENT_SMOKE_CHECKS,
  validateAgentRepositoryMetadata,
  validateAgentSmokeEvidence,
  validateIdentity,
  validateLocalAgentImageInspection,
  validateRuntimeIndex,
} from '../scripts/preview-runtime-images.mjs';

const workflow = readFileSync('.github/workflows/preview-runtime-images.yml', 'utf8');
const helper = readFileSync('scripts/preview-runtime-images.mjs', 'utf8');
const smoke = readFileSync('scripts/smoke-test-preview-agent-image.sh', 'utf8');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const digest = character => `sha256:${character.repeat(64)}`;
const fixtures = [];

const labels = (overrides = {}) => ({
  'org.opencontainers.image.revision': revision,
  'org.opencontainers.image.source': 'https://github.com/integry/propr',
  'dev.propr.agent-bundle': 'true',
  'dev.propr.agent.claude.version': '2.1.284',
  'dev.propr.agent.codex.version': '0.160.0',
  'dev.propr.agent.antigravity.version': '1.2.4',
  'dev.propr.agent.opencode.version': '1.18.31',
  'dev.propr.agent.vibe.version': '2.25.8',
  'dev.propr.agent-tank.version': '0.9.11',
  ...overrides,
});

const cliVersions = () => ({
  claude: '2.1.284', codex: '0.160.0', antigravity: '1.2.4', opencode: '1.18.31', vibe: '2.25.8', 'agent-tank': '0.9.11',
});

const smokeEvidence = (overrides = {}) => ({
  schemaVersion: 1,
  image: `propr/agent:${revision}`,
  sourceRevision: revision,
  configDigest: digest('c'),
  platform: 'linux/amd64',
  network: 'none',
  credentials: 'none',
  checks: [...AGENT_SMOKE_CHECKS],
  cliVersions: cliVersions(),
  ...overrides,
});

const job = (name, next) => {
  const start = workflow.indexOf(`\n  ${name}:`);
  const end = next ? workflow.indexOf(`\n  ${next}:`, start + 1) : workflow.length;
  assert.notEqual(start, -1, `missing ${name} job`);
  assert.notEqual(end, -1, `missing ${next} job`);
  return workflow.slice(start, end);
};

// Fake Docker for package-agent: inspect returns the configured image and
// `save` writes deterministic archive bytes; any other invocation fails.
const DOCKER_MOCK = String.raw`#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + '\n');
if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(process.env.DOCKER_INSPECTION + '\n');
  process.exit(0);
}
if (args[0] === 'save' && args[1] === '--output') {
  writeFileSync(args[2], 'agent-docker-save-' + args[3]);
  process.exit(0);
}
process.stderr.write('unexpected docker invocation\n');
process.exit(64);
`;

// Fake regctl: local ocidir and remote references for a linux/amd64-only agent.
const REGCTL_MOCK = String.raw`#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.REGCTL_LOG, JSON.stringify(args) + '\n');
const state = JSON.parse(readFileSync(process.env.REGCTL_STATE, 'utf8'));
const save = () => writeFileSync(process.env.REGCTL_STATE, JSON.stringify(state));
const child = 'sha256:' + 'a'.repeat(64);
const config = 'sha256:' + 'c'.repeat(64);
const top = 'sha256:' + 'e'.repeat(64);
const remoteTop = 'sha256:' + '9'.repeat(64);
const isRemote = ref => ref.startsWith('docker.io/');
const isPlain = ref => ref.includes('/agent-amd64') || ref.includes('@' + child);
if (args[0] === 'image' && args[1] === 'import') process.exit(0);
if (args[0] === 'index' && (args[1] === 'create' || args[1] === 'add')) process.exit(0);
if (args[0] === 'image' && args[1] === 'export') { writeFileSync(args[3], 'agent-oci-index'); process.exit(0); }
if (args[0] === 'image' && args[1] === 'copy') {
  state.copies.push(args[3]);
  state.published = true;
  save();
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'digest') {
  const ref = args[2];
  process.stdout.write((isPlain(ref) ? child : isRemote(ref) && process.env.REMOTE_MODE === 'existing-other' ? remoteTop : top) + '\n');
  process.exit(0);
}
if (args[0] === 'manifest' && args[1] === 'get') {
  const ref = args[2];
  if (isRemote(ref) && !ref.includes('@') && process.env.REMOTE_MODE === 'missing' && !state.published) {
    process.stderr.write('manifest unknown: not found\n');
    process.exit(1);
  }
  if (isPlain(ref)) {
    process.stdout.write(JSON.stringify({ schemaVersion: 2, config: { digest: config }, layers: [] }) + '\n');
  } else {
    const manifests = [{ digest: child, platform: { os: 'linux', architecture: 'amd64' } }];
    if (isRemote(ref) && process.env.REMOTE_MODE === 'multiarch') {
      manifests.push({ digest: 'sha256:' + 'b'.repeat(64), platform: { os: 'linux', architecture: 'arm64' } });
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 2, manifests }) + '\n');
  }
  process.exit(0);
}
if (args[0] === 'blob' && args[1] === 'get') {
  const remote = isRemote(args[2]);
  const labels = JSON.parse(process.env.AGENT_LABELS);
  if (remote && process.env.REMOTE_MODE === 'conflict') labels['org.opencontainers.image.revision'] = 'f'.repeat(40);
  process.stdout.write(JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Labels: labels } }) + '\n');
  process.exit(0);
}
process.stderr.write('unexpected regctl invocation: ' + JSON.stringify(args) + '\n');
process.exit(64);
`;

afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'propr-preview-agent-test.'));
  fixtures.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, source] of [['docker', DOCKER_MOCK], ['regctl', REGCTL_MOCK]]) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(root, 'state.json'), JSON.stringify({ published: false, copies: [] }));
  writeFileSync(join(root, 'docker.log'), '');
  writeFileSync(join(root, 'regctl.log'), '');
  const env = (overrides = {}) => ({
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    DOCKER_LOG: join(root, 'docker.log'),
    DOCKER_INSPECTION: JSON.stringify({
      Os: 'linux', Architecture: 'amd64', Id: digest('c'), Config: { Labels: labels() },
    }),
    REGCTL_LOG: join(root, 'regctl.log'),
    REGCTL_STATE: join(root, 'state.json'),
    AGENT_LABELS: JSON.stringify(labels()),
    REMOTE_MODE: 'missing',
    ...overrides,
  });
  const helperCommand = (args, overrides) => spawnSync('node', ['scripts/preview-runtime-images.mjs', ...args], {
    encoding: 'utf8', env: env(overrides),
  });
  const calls = name => readFileSync(join(root, `${name}.log`), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, helperCommand, calls, state: () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) };
};

const prepareCandidate = fixture => {
  const evidence = join(fixture.root, 'smoke.json');
  writeFileSync(evidence, JSON.stringify(smokeEvidence()));
  const native = join(fixture.root, 'native');
  const candidate = join(fixture.root, 'candidate');
  const packaged = fixture.helperCommand(['package-agent', '--source-revision', revision,
    '--smoke-evidence', evidence, '--output', native]);
  assert.equal(packaged.status, 0, packaged.stderr);
  const assembled = fixture.helperCommand(['assemble-agent', '--source-revision', revision,
    '--input', native, '--output', candidate]);
  assert.equal(assembled.status, 0, assembled.stderr);
  return { native, candidate };
};

describe('preview managed-agent candidate scope and source binding', () => {
  test('binds agent operations to main ancestry and the linux/amd64-only Dockerfile contract', () => {
    assert.deepEqual(validateAgentRepositoryMetadata(), {
      repository: { owner: 'integry', name: 'propr' },
      agentDockerfile: 'Dockerfile.agent',
      architectures: ['amd64'],
    });
    for (const operation of ['prepare-agent', 'publish-agent']) {
      assert.deepEqual(validateIdentity({
        sourceRevision: revision, workflowRevision: revision, dispatchRef: 'refs/heads/main', operation,
      }), { sourceRevision: revision, workflowRevision: revision, operation });
    }
    assert.throws(() => validateIdentity({
      sourceRevision: revision, workflowRevision: revision, dispatchRef: 'refs/heads/feature', operation: 'publish-agent',
    }), /main branch workflow only/);
    assert.throws(() => validateIdentity({
      sourceRevision: revision, workflowRevision: revision, dispatchRef: 'refs/heads/main', operation: 'publish-all',
    }), /operation must be/);
  });

  test('refuses a source whose agent Dockerfile drops the linux/amd64 pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'propr-preview-agent-source.'));
    fixtures.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ repository: { url: 'git+https://github.com/integry/propr.git' } }));
    for (const path of ['docker/Dockerfile.app.prod', 'propr-ui/Dockerfile']) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), 'FROM scratch\n');
    }
    writeFileSync(join(root, 'Dockerfile.agent'), 'ARG AGENT_PLATFORM=linux/arm64\n');
    assert.throws(() => validateAgentRepositoryMetadata(root), /linux\/amd64 contract/);
    writeFileSync(join(root, 'Dockerfile.agent'), 'ARG AGENT_PLATFORM=linux/amd64\n');
    assert.equal(validateAgentRepositoryMetadata(root).agentDockerfile, 'Dockerfile.agent');
  });

  test('accepts only source-labelled native linux/amd64 agent bundles', () => {
    const inspection = { Os: 'linux', Architecture: 'amd64', Id: digest('c'), Config: { Labels: labels() } };
    assert.equal(validateLocalAgentImageInspection(inspection, revision), inspection);
    assert.throws(() => validateLocalAgentImageInspection({ ...inspection, Architecture: 'arm64' }, revision),
      /supported linux\/amd64/);
    assert.throws(() => validateLocalAgentImageInspection({
      ...inspection, Config: { Labels: labels({ 'org.opencontainers.image.revision': 'f'.repeat(40) }) },
    }, revision), /exact integry\/propr source revision/);
    assert.throws(() => validateLocalAgentImageInspection({
      ...inspection, Config: { Labels: labels({ 'dev.propr.agent-bundle': undefined }) },
    }, revision), /unified ProPR agent bundle/);
    assert.throws(() => validateLocalAgentImageInspection({
      ...inspection, Config: { Labels: labels({ 'dev.propr.agent.codex.version': '' }) },
    }, revision), /bundled codex version label/);
  });

  test('requires complete credential-free smoke evidence for the exact config', () => {
    const expected = { sourceRevision: revision, configDigest: digest('c'), labels: labels() };
    assert.ok(validateAgentSmokeEvidence(smokeEvidence(), expected));
    assert.throws(() => validateAgentSmokeEvidence(smokeEvidence({ checks: AGENT_SMOKE_CHECKS.slice(1) }), expected),
      /missing a required check/);
    assert.throws(() => validateAgentSmokeEvidence(smokeEvidence({ credentials: 'mounted' }), expected),
      /exact credential-free candidate/);
    assert.throws(() => validateAgentSmokeEvidence(smokeEvidence({ configDigest: digest('d') }), expected),
      /exact credential-free candidate/);
    assert.throws(() => validateAgentSmokeEvidence(smokeEvidence({ platform: 'linux/arm64' }), expected),
      /exact credential-free candidate/);
    assert.throws(() => validateAgentSmokeEvidence(smokeEvidence({
      cliVersions: { ...cliVersions(), claude: '0.0.1' },
    }), expected), /claude version does not match/);
  });

  test('requires a registry index to contain exactly linux/amd64 for the agent', () => {
    const amd64 = { digest: digest('a'), platform: { os: 'linux', architecture: 'amd64' } };
    const arm64 = { digest: digest('b'), platform: { os: 'linux', architecture: 'arm64' } };
    assert.equal(validateRuntimeIndex({ manifests: [amd64] }, 'agent', revision, ['amd64']).length, 1);
    assert.throws(() => validateRuntimeIndex({ manifests: [amd64, arm64] }, 'agent', revision, ['amd64']),
      /exactly linux\/amd64/);
    assert.throws(() => validateRuntimeIndex({ manifests: [arm64] }, 'agent', revision, ['amd64']),
      /exactly linux\/amd64/);
    assert.throws(() => validateRuntimeIndex({ manifests: [amd64] }, 'docs', revision, ['amd64']), /Unexpected/);
  });
});

describe('preview managed-agent prepare and publish boundaries', () => {
  test('prepares immutable candidate evidence without any registry mutation or credential', () => {
    const fixture = createFixture();
    const { native, candidate } = prepareCandidate(fixture);
    const nativeMetadata = JSON.parse(readFileSync(join(native, 'preview-agent-native.json'), 'utf8'));
    assert.equal(nativeMetadata.architecture, 'amd64');
    assert.equal(nativeMetadata.image.configDigest, digest('c'));
    assert.deepEqual(nativeMetadata.smoke.checks, [...AGENT_SMOKE_CHECKS]);
    const metadata = JSON.parse(readFileSync(join(candidate, 'preview-agent-candidate.json'), 'utf8'));
    assert.equal(metadata.sourceRevision, revision);
    assert.equal(metadata.platform, 'linux/amd64');
    assert.equal(metadata.image.manifestDigest, digest('e'));
    assert.equal(metadata.image.configDigest, digest('c'));
    assert.match(metadata.image.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(fixture.calls('docker').map(args => args[0]), ['image', 'save']);
    const regctl = fixture.calls('regctl');
    assert.ok(regctl.some(args => args[0] === 'index' && args.includes('linux/amd64')));
    assert.equal(regctl.some(args => args.includes('linux/arm64')), false);
    assert.equal(regctl.some(args => args[1] === 'copy' || args.some(arg => arg.startsWith('docker.io/'))), false);
  });

  test('refuses an arm64-labelled image or incomplete smoke before saving any archive', () => {
    const fixture = createFixture();
    const evidence = join(fixture.root, 'smoke.json');
    writeFileSync(evidence, JSON.stringify(smokeEvidence()));
    const wrongArch = fixture.helperCommand(['package-agent', '--source-revision', revision,
      '--smoke-evidence', evidence, '--output', join(fixture.root, 'native')], {
      DOCKER_INSPECTION: JSON.stringify({ Os: 'linux', Architecture: 'arm64', Id: digest('c'), Config: { Labels: labels() } }),
    });
    assert.notEqual(wrongArch.status, 0);
    assert.match(wrongArch.stderr, /supported linux\/amd64/);
    writeFileSync(evidence, JSON.stringify(smokeEvidence({ checks: ['bundled-clis-present'] })));
    const incomplete = fixture.helperCommand(['package-agent', '--source-revision', revision,
      '--smoke-evidence', evidence, '--output', join(fixture.root, 'native')]);
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /missing a required check/);
    const missing = fixture.helperCommand(['package-agent', '--source-revision', revision,
      '--output', join(fixture.root, 'native')]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /requires --smoke-evidence/);
    assert.equal(fixture.calls('docker').some(args => args[0] === 'save'), false);
    assert.equal(existsSync(join(fixture.root, 'native', 'agent-linux-amd64.docker.tar')), false);
  });

  test('refuses tampered native or candidate bytes', () => {
    const fixture = createFixture();
    const { native, candidate } = prepareCandidate(fixture);
    writeFileSync(join(native, 'agent-linux-amd64.docker.tar'), 'tampered');
    const reassembled = fixture.helperCommand(['assemble-agent', '--source-revision', revision,
      '--input', native, '--output', join(fixture.root, 'again')]);
    assert.notEqual(reassembled.status, 0);
    assert.match(reassembled.stderr, /archive digest mismatch/);
    writeFileSync(join(candidate, 'extra.txt'), 'unexpected');
    const extra = fixture.helperCommand(['publish-agent', '--source-revision', revision, '--input', candidate]);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /unexpected file/);
    assert.deepEqual(fixture.state().copies, []);
  });

  test('publishes only the missing full-SHA agent tag and emits its digest-pinned reference', () => {
    const fixture = createFixture();
    const { candidate } = prepareCandidate(fixture);
    const githubOutput = join(fixture.root, 'github-output');
    const summary = join(fixture.root, 'summary');
    const result = fixture.helperCommand(['publish-agent', '--source-revision', revision, '--input', candidate,
      '--github-output', githubOutput, '--step-summary', summary]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fixture.state().copies, [`docker.io/propr/agent:${revision}`]);
    assert.equal(readFileSync(githubOutput, 'utf8'), `runtime_agent_image=propr/agent:${revision}@${digest('e')}\n`);
    assert.match(readFileSync(summary, 'utf8'), /linux\/amd64 only/);
    const mutations = fixture.calls('regctl').filter(args => args[1] === 'copy');
    assert.equal(mutations.some(args => /\/(?:app|ui|docs|launcher):|:latest$|:\d+\.\d+\.\d+$/.test(args[3])), false);
  });

  test('keeps an existing source-bound tag instead of overwriting it, and is idempotent', () => {
    const fixture = createFixture();
    const { candidate } = prepareCandidate(fixture);
    const githubOutput = join(fixture.root, 'github-output');
    const result = fixture.helperCommand(['publish-agent', '--source-revision', revision, '--input', candidate,
      '--github-output', githubOutput], { REMOTE_MODE: 'existing-other' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fixture.state().copies, []);
    assert.equal(readFileSync(githubOutput, 'utf8'), `runtime_agent_image=propr/agent:${revision}@${digest('9')}\n`);
  });

  test('fails closed before mutation for a conflicting-source or multi-architecture existing tag', () => {
    for (const [mode, message] of [
      ['conflict', /not independently bound to the requested source/],
      ['multiarch', /exactly linux\/amd64/],
    ]) {
      const fixture = createFixture();
      const { candidate } = prepareCandidate(fixture);
      const result = fixture.helperCommand(['publish-agent', '--source-revision', revision, '--input', candidate],
        { REMOTE_MODE: mode });
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stderr, message);
      assert.deepEqual(fixture.state().copies, [], mode);
    }
  });
});

describe('preview managed-agent workflow boundaries', () => {
  test('keeps agent operations separate from the app/UI jobs', () => {
    assert.match(workflow, /options:\n\s+- prepare\n\s+- publish\n\s+- prepare-agent\n\s+- publish-agent\n/);
    for (const name of ['build-native', 'assemble']) {
      assert.match(job(name, name === 'build-native' ? 'assemble' : 'publish'),
        /if: inputs\.operation == 'prepare' \|\| inputs\.operation == 'publish'\n/);
    }
    assert.match(job('publish', 'build-agent'), /if: inputs\.operation == 'publish'\n/);
    assert.match(job('build-agent', 'assemble-agent'),
      /if: inputs\.operation == 'prepare-agent' \|\| inputs\.operation == 'publish-agent'\n/);
    assert.match(job('publish-agent'), /if: inputs\.operation == 'publish-agent'\n/);
  });

  test('builds the agent credential-free on native amd64 with the existing SHA-only builder', () => {
    const build = job('build-agent', 'assemble-agent');
    const assemble = job('assemble-agent', 'publish-agent');
    assert.doesNotMatch(build, /secrets\.|environment:|docker login/);
    assert.doesNotMatch(assemble, /secrets\.|environment:|docker login|image copy/);
    assert.match(build, /runs-on: ubuntu-24\.04\n/);
    assert.doesNotMatch(build, /ubuntu-24\.04-arm|arm64/);
    assert.match(build, /build-images\.sh --sha-only --only agent --platform linux\/amd64/);
    assert.match(build, /smoke-test-preview-agent-image\.sh/);
    assert.match(build, /preview-runtime-images\.mjs package-agent[\s\S]+--smoke-evidence/);
    assert.match(assemble, /preview-runtime-images\.mjs assemble-agent/);
    assert.match(assemble, /ref: \$\{\{ github\.sha \}\}/);
  });

  test('publishes only behind the existing runtime publication environment after verification', () => {
    const publish = job('publish-agent');
    assert.match(publish, /environment:\n\s+name: desktop-linux-preview-runtime-publication\n/);
    assert.match(publish, /PROPR_DESKTOP_LINUX_PREVIEW_RUNTIME_PUBLICATION_AUTHORIZED/);
    assert.match(publish, /needs: \[identity, assemble-agent\]/);
    assert.match(publish, /preview-runtime-images\.mjs publish-agent/);
    assert.doesNotMatch(publish, /preview-runtime-images\.mjs publish(?!-agent)/);
    assert.ok(publish.indexOf('Download only the verified agent candidate') < publish.indexOf('Authenticate only after'));
    assert.equal(workflow.match(/environment:\n\s+name: ([\w-]+)/g).length, 2);
    assert.doesNotMatch(workflow, /environment:\n\s+name: (?!desktop-linux-preview-runtime-publication\n)/);
    assert.doesNotMatch(workflow, /docker-images\.yml|npm publish|gh release|--push(?:\s|$)|--promote-latest|:latest/);
  });

  test('smoke script stays offline, credential-free, and bound to the exact full-SHA tag', () => {
    assert.match(smoke, /AGENT_IMAGE" != "propr\/agent:\$SOURCE_REVISION"/);
    assert.match(smoke, /docker run --rm --network none --pull never/);
    assert.match(smoke, /Refusing to run the credential-free agent smoke/);
    assert.doesNotMatch(smoke, /docker\.sock|--volume|--mount|docker login|docker push/);
    const containerRuns = smoke.split('\n').filter(line => /run_agent|docker run/.test(line));
    assert.ok(containerRuns.length >= 6);
    assert.equal(containerRuns.some(line => /\s-v\s/.test(line)), false);
    assert.match(smoke, /linux\/amd64/);
    for (const check of AGENT_SMOKE_CHECKS) assert.match(smoke, new RegExp(`"${check}"`));
    assert.equal(spawnSync('bash', ['-n', 'scripts/smoke-test-preview-agent-image.sh']).status, 0);
    assert.match(helper, /AGENT_ARCHITECTURES = \['amd64'\]/);
  });
});
