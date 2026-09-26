import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  validateIdentity,
  validateLocalDockerImageInspection,
  validateRepositoryMetadata,
  validateRuntimeIndex,
} from '../scripts/preview-runtime-images.mjs';

const workflow = readFileSync('.github/workflows/preview-runtime-images.yml', 'utf8');
const helper = readFileSync('scripts/preview-runtime-images.mjs', 'utf8');
const smoke = readFileSync('scripts/smoke-test-preview-runtime-images.sh', 'utf8');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const fixtures = [];
const digest = character => `sha256:${character.repeat(64)}`;

const REGCTL_MOCK = String.raw`#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.REGCTL_STATE, 'utf8'));
appendFileSync(process.env.REGCTL_LOG, JSON.stringify(args) + '\n');
const save = () => writeFileSync(process.env.REGCTL_STATE, JSON.stringify(state));
const sha = process.env.SOURCE_REVISION;
const childAmd64 = 'sha256:' + 'a'.repeat(64);
const childArm64 = 'sha256:' + 'b'.repeat(64);
const configAmd64 = 'sha256:' + 'c'.repeat(64);
const configArm64 = 'sha256:' + 'd'.repeat(64);
const topDigest = 'sha256:' + 'e'.repeat(64);
const reference = args[2] || '';

if (args[0] === 'image' && args[1] === 'import') process.exit(0);
if (args[0] === 'image' && args[1] === 'digest') {
  process.stdout.write(topDigest + '\n');
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'copy') {
  const target = args[3];
  state.published[target.includes('/app:') ? 'app' : 'ui'] = true;
  save();
  process.exit(0);
}
if (args[0] === 'manifest' && args[1] === 'get') {
  const remote = reference.startsWith('docker.io/propr/');
  const image = reference.includes('/app') ? 'app' : 'ui';
  if (remote && !reference.includes('@') && process.env.REMOTE_MODE === 'missing' && !state.published[image]) {
    process.stderr.write('manifest unknown: not found\n');
    process.exit(1);
  }
  if (reference.includes('@' + childAmd64)) {
    process.stdout.write(JSON.stringify({ schemaVersion: 2, config: { digest: configAmd64 }, layers: [] }));
  } else if (reference.includes('@' + childArm64)) {
    process.stdout.write(JSON.stringify({ schemaVersion: 2, config: { digest: configArm64 }, layers: [] }));
  } else {
    process.stdout.write(JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        { digest: childAmd64, platform: { os: 'linux', architecture: 'amd64' } },
        { digest: childArm64, platform: { os: 'linux', architecture: 'arm64' } },
      ],
    }));
  }
  process.stdout.write('\n');
  process.exit(0);
}
if (args[0] === 'blob' && args[1] === 'get') {
  const remote = args[2].startsWith('docker.io/propr/');
  const architecture = args[3] === configAmd64 ? 'amd64' : 'arm64';
  const sourceRevision = remote && process.env.REMOTE_MODE === 'conflict' ? 'f'.repeat(40) : sha;
  process.stdout.write(JSON.stringify({
    os: 'linux', architecture,
    config: { Labels: {
      'org.opencontainers.image.revision': sourceRevision,
      'org.opencontainers.image.source': 'https://github.com/integry/propr',
    } },
  }) + '\n');
  process.exit(0);
}
process.stderr.write('unexpected regctl invocation: ' + JSON.stringify(args) + '\n');
process.exit(64);
`;

afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

const createPublishFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'propr-preview-runtime-publish-test.'));
  fixtures.push(root);
  const bin = join(root, 'bin');
  const candidate = join(root, 'candidate');
  mkdirSync(bin);
  mkdirSync(candidate);
  const regctl = join(bin, 'regctl');
  writeFileSync(regctl, REGCTL_MOCK);
  chmodSync(regctl, 0o755);
  const images = {};
  for (const image of ['app', 'ui']) {
    const archive = `${image}.oci.tar`;
    const content = `${image}-verified-oci-candidate`;
    writeFileSync(join(candidate, archive), content);
    images[image] = {
      archive,
      sha256: createHash('sha256').update(content).digest('hex'),
      manifestDigest: digest('e'),
    };
  }
  writeFileSync(join(candidate, 'preview-runtime-candidate.json'), JSON.stringify({
    schemaVersion: 1,
    sourceRevision: revision,
    repository: { owner: 'integry', name: 'propr' },
    images,
  }));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ published: {} }));
  writeFileSync(join(root, 'regctl.log'), '');
  return { root, bin, candidate };
};

const job = (name, next) => {
  const start = workflow.indexOf(`\n  ${name}:`);
  const end = next ? workflow.indexOf(`\n  ${next}:`, start + 1) : workflow.length;
  assert.notEqual(start, -1, `missing ${name} job`);
  assert.notEqual(end, -1, `missing ${next} job`);
  return workflow.slice(start, end);
};

describe('preview runtime image trust and input gates', () => {
  test('executes identity validation against the repository metadata and Git graph', () => {
    assert.deepEqual(validateRepositoryMetadata(), {
      repository: { owner: 'integry', name: 'propr' },
      imageDockerfiles: {
        app: 'docker/Dockerfile.app.prod',
        ui: 'propr-ui/Dockerfile',
      },
    });
    assert.deepEqual(validateIdentity({
      sourceRevision: revision,
      workflowRevision: revision,
      dispatchRef: 'refs/heads/main',
      operation: 'prepare',
    }), { sourceRevision: revision, workflowRevision: revision, operation: 'prepare' });
  });

  test('fails closed for abbreviated/mixed-case identities and non-main dispatches', () => {
    assert.throws(() => validateIdentity({
      sourceRevision: revision.slice(0, 12), workflowRevision: revision,
      dispatchRef: 'refs/heads/main', operation: 'prepare',
    }), /full lowercase 40-character/);
    assert.throws(() => validateIdentity({
      sourceRevision: revision, workflowRevision: revision,
      dispatchRef: 'refs/heads/release', operation: 'publish',
    }), /main branch workflow only/);
  });

  test('is manual-only with validation as the default operation', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/m);
    assert.match(workflow, /default: prepare\n\s+options:\n\s+- prepare\n\s+- publish/);
    assert.match(job('identity', 'build-native'), /--dispatch-ref "\$DISPATCH_REF"/);
    assert.match(job('identity', 'build-native'), /--workflow-revision "\$WORKFLOW_SHA"/);
  });
});

describe('preview runtime artifact and immutable publication scope', () => {
  test('accepts only exact source-labelled native app/UI image evidence', () => {
    const inspection = {
      Os: 'linux',
      Architecture: 'amd64',
      Id: `sha256:${'a'.repeat(64)}`,
      Config: { Labels: {
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.source': 'https://github.com/integry/propr',
      } },
    };
    assert.equal(validateLocalDockerImageInspection(inspection, 'app', revision, 'amd64'), inspection);
    assert.throws(() => validateLocalDockerImageInspection(inspection, 'docs', revision, 'amd64'), /Unexpected/);
    assert.throws(() => validateLocalDockerImageInspection({
      ...inspection,
      Config: { Labels: { ...inspection.Config.Labels, 'org.opencontainers.image.revision': 'b'.repeat(40) } },
    }, 'app', revision, 'amd64'), /exact integry\/propr source revision/);
  });

  test('requires exactly the two native Linux architectures and rejects extras', () => {
    const descriptor = architecture => ({
      digest: `sha256:${architecture === 'amd64' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
      platform: { os: 'linux', architecture },
    });
    assert.equal(validateRuntimeIndex({ manifests: [descriptor('amd64'), descriptor('arm64')] }, 'ui', revision).length, 2);
    assert.equal(validateRuntimeIndex({ manifests: [descriptor('amd64'), descriptor('arm64'), {
      digest: `sha256:${'d'.repeat(64)}`,
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: {
        'vnd.docker.reference.type': 'attestation-manifest',
        'vnd.docker.reference.digest': digest('a'),
      },
    }] }, 'ui', revision).length, 2);
    assert.throws(() => validateRuntimeIndex({
      manifests: [descriptor('amd64'), descriptor('arm64'), {
        digest: `sha256:${'c'.repeat(64)}`,
        platform: { os: 'linux', architecture: 's390x' },
      }],
    }, 'ui', revision), /exactly linux\/amd64 and linux\/arm64/);
  });

  test('keeps source builds secretless and puts the only registry mutation behind protection', () => {
    const build = job('build-native', 'assemble');
    const assemble = job('assemble', 'publish');
    const publish = job('publish');
    assert.doesNotMatch(build, /secrets\.|environment:/);
    assert.doesNotMatch(assemble, /secrets\.|environment:|docker login|image copy/);
    assert.match(publish, /environment:\n\s+name: desktop-linux-preview-runtime-publication/);
    assert.match(publish, /PROPR_DESKTOP_LINUX_PREVIEW_RUNTIME_PUBLICATION_AUTHORIZED/);
    assert.match(publish, /secrets\.DOCKERHUB_USERNAME/);
    assert.match(publish, /preview-runtime-images\.mjs publish/);
    assert.ok(publish.indexOf('Download only the verified candidate') < publish.indexOf('Authenticate only after'));
  });

  test('publishes only missing exact full-SHA tags and emits verified manifest inputs', () => {
    const { root, bin, candidate } = createPublishFixture();
    const githubOutput = join(root, 'github-output');
    const stepSummary = join(root, 'step-summary');
    writeFileSync(githubOutput, '');
    writeFileSync(stepSummary, '');
    const result = spawnSync('node', [
      'scripts/preview-runtime-images.mjs', 'publish',
      '--source-revision', revision,
      '--input', candidate,
      '--github-output', githubOutput,
      '--step-summary', stepSummary,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        REGCTL_LOG: join(root, 'regctl.log'),
        REGCTL_STATE: join(root, 'state.json'),
        REMOTE_MODE: 'missing',
        SOURCE_REVISION: revision,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(root, 'regctl.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const copies = calls.filter(args => args[0] === 'image' && args[1] === 'copy');
    assert.deepEqual(copies.map(args => args[3]), [
      `docker.io/propr/app:${revision}`,
      `docker.io/propr/ui:${revision}`,
    ]);
    assert.equal(copies.some(args => /:latest$|:0\.8\.15$/.test(args[3])), false);
    assert.equal(readFileSync(githubOutput, 'utf8'), [
      `runtime_app_image=propr/app:${revision}@${digest('e')}`,
      `runtime_ui_image=propr/ui:${revision}@${digest('e')}`,
      '',
    ].join('\n'));
  });

  test('fails before registry mutation when an existing full-SHA tag conflicts', () => {
    const { root, bin, candidate } = createPublishFixture();
    const result = spawnSync('node', [
      'scripts/preview-runtime-images.mjs', 'publish',
      '--source-revision', revision,
      '--input', candidate,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        REGCTL_LOG: join(root, 'regctl.log'),
        REGCTL_STATE: join(root, 'state.json'),
        REMOTE_MODE: 'conflict',
        SOURCE_REVISION: revision,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not independently bound to the requested source/);
    const calls = readFileSync(join(root, 'regctl.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.some(args => args[0] === 'image' && args[1] === 'copy'), false);
  });

  test('uses the local SHA-only builder and never invokes stable publication surfaces', () => {
    assert.match(workflow, /build-images\.sh --sha-only --only app,ui/);
    assert.match(workflow, /APP_IMAGE: propr\/app:\$\{\{ needs\.identity\.outputs\.source_revision \}\}/);
    assert.match(workflow, /UI_IMAGE: propr\/ui:\$\{\{ needs\.identity\.outputs\.source_revision \}\}/);
    assert.doesNotMatch(workflow, /docker-images\.yml|release:verify|npm publish|gh release|--push(?:\s|$)|--promote-latest/);
    assert.match(helper, /`docker\.io\/propr\/\$\{image\}:\$\{sourceRevision\}`/);
    assert.doesNotMatch(helper, /:latest|expected.version|npm|desktop.release/);
    assert.match(smoke, /api\/desktop\/discovery/);
    assert.match(smoke, /config\.js/);
  });

  test('boots the real no-work worker without Docker socket or agent-image access', () => {
    const migration = smoke.indexOf('npx knex migrate:latest');
    const noWorkBootstrap = smoke.indexOf("saveAgents([{ id: '00000000-0000-4000-8000-000000000001'");
    const workerStart = smoke.indexOf('node dist/src/worker.js');
    const workerLiveness = smoke.indexOf('"$DAEMON_CONTAINER" "$WORKER_CONTAINER"');

    assert.ok(migration !== -1 && migration < noWorkBootstrap, 'schema migration must precede fixture configuration');
    assert.ok(noWorkBootstrap < workerStart, 'the explicit no-work configuration must precede worker startup');
    assert.match(smoke, /alias: 'preview-runtime-no-work', enabled: false/);
    assert.doesNotMatch(smoke, /\/var\/run\/docker\.sock|Dockerfile\.agent|propr\/agent:(?!preview-runtime-no-work)/);
    assert.ok(workerStart < workerLiveness, 'the real worker process must be covered by the final liveness gate');
  });

  test('shell entry points are syntactically executable', () => {
    for (const path of ['scripts/build-images.sh', 'scripts/smoke-test-preview-runtime-images.sh']) {
      const result = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  });
});
