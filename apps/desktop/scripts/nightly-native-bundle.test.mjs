import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import {
  CHECKSUMS,
  classifyNightly,
  createNightlyBundle,
  describeRuntimeBinding,
  NIGHTLY_MANIFEST,
  NIGHTLY_NOTES,
  readNightlyChecks,
  renderRunSummary,
  renderUnsummarizedSummary,
  renderWithheldSummary,
  verifyNightlyBundle,
} from './nightly-native-bundle.mjs';
import { expectedProfileArtifacts, MACOS_LINUX_RELEASE_PROFILE, resolveReleaseProfile } from './release-profiles.mjs';

const execFile = promisify(execFileCallback);
const script = fileURLToPath(new URL('./nightly-native-bundle.mjs', import.meta.url));
const version = '1.2.3';
const sourceSha = 'a'.repeat(40);
const run = {
  repository: 'integry/propr',
  id: '38016752734',
  attempt: '2',
  serverUrl: 'https://github.com',
  workflow: 'Nightly Test Suite (Tier 3)',
  ref: 'refs/heads/main',
  eventName: 'schedule',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const launcherManifest = `${JSON.stringify({
  version: '0.9.0',
  git_sha: 'c'.repeat(40),
  images: { app: 'propr/app:0.9.0', ui: 'propr/ui:0.9.0', agent: 'propr/agent:0.9.0' },
}, null, 2)}\n`;
const readRuntimeManifest = async () => launcherManifest;

const needsWith = (overrides = {}) => {
  const needs = {
    'e2e-tests': { result: 'success', outputs: { full_tests: 'success', e2e_config: 'success', e2e_tests: 'success' } },
    'native-electron': { result: 'success', outputs: {} },
    'desktop-package': { result: 'success', outputs: { version } },
    'desktop-connect': { result: 'success', outputs: {} },
  };
  for (const [job, value] of Object.entries(overrides)) {
    if (value === undefined) delete needs[job];
    else needs[job] = { ...needs[job], ...value, outputs: { ...needs[job]?.outputs, ...value.outputs } };
  }
  return JSON.stringify(needs);
};
// The shape of nightly runs 38016752734 and 38035895093: packaging green, live E2E red.
const e2eFailed = needsWith({
  'e2e-tests': { result: 'failure', outputs: { e2e_tests: 'failure' } },
});

const createFinalDirectory = async (root, { mutate } = {}) => {
  const directory = join(root, 'desktop-release-final');
  await mkdir(directory);
  const artifacts = [];
  for (const [fileName, metadata] of expectedProfileArtifacts(resolveReleaseProfile(MACOS_LINUX_RELEASE_PROFILE), version)) {
    const bytes = Buffer.from(`${metadata.platform}-${metadata.arch}-${metadata.kind}\n`);
    await writeFile(join(directory, fileName), bytes);
    artifacts.push({
      ...metadata,
      fileName,
      size: bytes.length,
      sha256: digest(bytes),
      architectureEvidence: { format: metadata.kind, executable: { architectures: [metadata.arch] } },
    });
  }
  artifacts.sort((left, right) => left.fileName.localeCompare(right.fileName));
  const manifest = {
    schemaVersion: 2,
    releaseProfile: MACOS_LINUX_RELEASE_PROFILE,
    channel: 'stable',
    version,
    tag: `desktop-v${version}`,
    publishedAt: '2026-10-10T02:00:00.000Z',
    feeds: {},
    nativeSigners: {},
    artifacts,
  };
  await mutate?.({ directory, manifest });
  await writeFile(join(directory, 'desktop-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!existsSync(join(directory, CHECKSUMS))) {
    await writeFile(join(directory, CHECKSUMS), `${manifest.artifacts.map(artifact => `${artifact.sha256}  ${artifact.fileName}`).join('\n')}\n`);
  }
  return directory;
};

const withRoot = async callback => {
  const root = await mkdtemp(join(tmpdir(), 'propr-nightly-bundle-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const bundle = (root, inputDirectory, options = {}) => createNightlyBundle({
  inputDirectory,
  outputDirectory: join(root, 'propr-desktop-nightly'),
  version,
  sourceSha,
  run,
  needs: e2eFailed,
  e2eModelPairs: '8',
  createdAt: '2026-10-10T04:00:00.000Z',
  readRuntimeManifest,
  ...options,
});

describe('nightly readiness classification', () => {
  test('a fully green nightly is a release-validation candidate but never promotable', () => {
    const status = classifyNightly(readNightlyChecks(needsWith()));
    assert.deepEqual(status, {
      packaging: 'passed', nightly: 'passed', releaseValidationCandidate: true, promotable: false, blockers: [],
    });
  });

  test('a live E2E failure keeps the packaging download but blocks readiness', () => {
    const status = classifyNightly(readNightlyChecks(e2eFailed));
    assert.equal(status.packaging, 'passed');
    assert.equal(status.nightly, 'failed');
    assert.equal(status.releaseValidationCandidate, false);
    assert.deepEqual(status.blockers, [
      'Live E2E (plan generation and model tasks): failure',
      'Run E2E Test Suite job: failure',
    ]);
  });

  test('cancelled, skipped, and missing checks are incomplete, never success', () => {
    for (const needs of [
      needsWith({ 'desktop-connect': { result: 'cancelled' } }),
      needsWith({ 'e2e-tests': { outputs: { e2e_tests: 'skipped' } } }),
      needsWith({ 'native-electron': undefined }),
      needsWith({ 'e2e-tests': { outputs: { e2e_tests: 'unexpected' } } }),
    ]) {
      const status = classifyNightly(readNightlyChecks(needs));
      assert.equal(status.nightly, 'incomplete', needs);
      assert.equal(status.releaseValidationCandidate, false);
      assert.equal(status.blockers.length, 1);
    }
    assert.equal(readNightlyChecks(needsWith({ 'native-electron': undefined }))
      .find(check => check.id === 'native-electron').outcome, 'not-run');
  });

  test('packaging that did not succeed is never reported as passed', () => {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      const needs = result ? needsWith({ 'desktop-package': { result } }) : needsWith({ 'desktop-package': undefined });
      const status = classifyNightly(readNightlyChecks(needs));
      assert.equal(status.packaging, 'not-passed', String(result));
      assert.equal(status.releaseValidationCandidate, false);
    }
  });
});

describe('nightly native bundle provenance', () => {
  test('binds source, run, version, matrix, digests, signing, runtime, and real check outcomes', () => withRoot(async root => {
    const manifest = await bundle(root, await createFinalDirectory(root));
    const output = join(root, 'propr-desktop-nightly');
    assert.equal(manifest.source.sha, sourceSha);
    assert.equal(manifest.source.commitUrl, `https://github.com/integry/propr/commit/${sourceSha}`);
    assert.deepEqual(manifest.run, {
      id: 38016752734,
      attempt: 2,
      url: 'https://github.com/integry/propr/actions/runs/38016752734/attempts/2',
      workflow: run.workflow,
      event: 'schedule',
    });
    assert.equal(manifest.version, version);
    assert.equal(manifest.artifactName, `propr-desktop-nightly-${version}-aaaaaaaaaaaa-run38016752734.2-packaging-only`);
    assert.deepEqual(manifest.platforms.map(platform => `${platform.target}:${platform.formats.join('+')}`),
      ['linux-x64:deb+rpm+zip', 'linux-arm64:deb+rpm+zip', 'darwin-x64:dmg+zip', 'darwin-arm64:dmg+zip']);
    assert.match(manifest.platforms.find(platform => platform.target === 'darwin-arm64').signing, /^ad-hoc/);
    assert.equal(manifest.platforms.find(platform => platform.target === 'linux-x64').signing, 'unsigned');
    assert.deepEqual(manifest.signing, {
      status: 'unsigned-validation', notarized: false, updateMetadataSigned: false, updateFeeds: 'none',
    });
    assert.equal(manifest.artifacts.length, 10);
    for (const artifact of manifest.artifacts) {
      assert.equal(digest(await readFile(join(output, artifact.fileName))), artifact.sha256);
    }
    assert.equal(manifest.externalPublication, 'none');
    assert.equal(manifest.liveE2E.backendSourceAttestation, 'unavailable');
    assert.equal(manifest.liveE2E.allProviders, false);
    assert.equal(manifest.liveE2E.modelPairLimit, 8);
    assert.equal(manifest.status.nightly, 'failed');
    assert.equal(manifest.status.promotable, false);
    assert.equal(manifest.checks.find(check => check.id === 'live-e2e').outcome, 'failure');
    assert.equal(manifest.runtime.linux.binding, 'unbound');
    assert.equal(manifest.runtime.linux.currentSource, false);
    assert.equal(manifest.runtime.linux.launcherSourceRevision, 'c'.repeat(40));
    assert.deepEqual(manifest.runtime.linux.images, {
      app: 'propr/app:0.9.0', ui: 'propr/ui:0.9.0', agent: 'propr/agent:0.9.0',
    });
    assert.deepEqual((await readdir(output)).sort(), [
      ...manifest.artifacts.map(artifact => artifact.fileName), CHECKSUMS, NIGHTLY_NOTES, NIGHTLY_MANIFEST,
    ].sort());
    assert.ok(!(await readdir(output)).includes('desktop-release.json'),
      'the unsigned finalize manifest (channel "stable") is not shipped as if it were a release manifest');
    assert.deepEqual(JSON.parse(await readFile(join(output, NIGHTLY_MANIFEST), 'utf8')), manifest);
    const notes = await readFile(join(output, NIGHTLY_NOTES), 'utf8');
    assert.match(notes, /Packaging-only download\. The nightly failed/);
    assert.match(notes, /Runtime binding: \*\*unbound\*\*/);
    assert.match(notes, /Desktop Linux Preview\nRelease path/);
    assert.match(notes, /- Live E2E \(plan generation and model tasks\): failure/);
  }));

  test('names a fully green nightly as such', () => withRoot(async root => {
    const manifest = await bundle(root, await createFinalDirectory(root), { needs: needsWith() });
    assert.match(manifest.artifactName, /-all-checks-passed$/);
    assert.equal(manifest.status.releaseValidationCandidate, true);
    assert.equal(manifest.status.promotable, false);
  }));

  test('withholds the bundle when packaging did not succeed', () => withRoot(async root => {
    const input = await createFinalDirectory(root);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      await assert.rejects(bundle(root, input, { needs: needsWith({ 'desktop-package': { result } }) }), /withheld/);
    }
    assert.equal(existsSync(join(root, 'propr-desktop-nightly')), false);
  }));

  test('fails closed on a missing platform, corrupt bytes, checksum mismatch, extra file, or signer evidence', () => withRoot(async root => {
    const cases = [
      [async ({ directory, manifest }) => {
        const removed = manifest.artifacts.filter(artifact => artifact.platform === 'darwin' && artifact.arch === 'x64');
        manifest.artifacts = manifest.artifacts.filter(artifact => !removed.includes(artifact));
        for (const artifact of removed) await rm(join(directory, artifact.fileName));
      }, /exactly the macos-linux-v1 matrix/],
      [async ({ directory, manifest }) => {
        await writeFile(join(directory, manifest.artifacts[0].fileName), 'tampered\n');
      }, /do not match/],
      [async ({ directory, manifest }) => {
        await writeFile(join(directory, CHECKSUMS), `${manifest.artifacts
          .map((artifact, index) => `${index === 0 ? 'f'.repeat(64) : artifact.sha256}  ${artifact.fileName}`).join('\n')}\n`);
      }, /do not match/],
      [async ({ directory }) => { await writeFile(join(directory, 'extra.txt'), 'x'); }, /exactly the macos-linux-v1 matrix/],
      [async ({ manifest }) => {
        manifest.nativeSigners = { 'darwin-arm64': { type: 'apple-team-id', identity: 'X', designatedRequirement: 'Y' } };
      }, /no production signer evidence/],
      [async ({ manifest }) => { manifest.version = '9.9.9'; }, /does not match the nightly version/],
    ];
    for (const [index, [mutate, expected]] of cases.entries()) {
      const caseRoot = join(root, `case-${index}`);
      await mkdir(caseRoot);
      await assert.rejects(bundle(caseRoot, await createFinalDirectory(caseRoot, { mutate })), expected, `case ${index}`);
    }
  }));

  test('requires one identical packaged runtime manifest across Linux architectures', () => withRoot(async root => {
    const input = await createFinalDirectory(root);
    await assert.rejects(bundle(root, input, {
      readRuntimeManifest: async ({ arch }) => (arch === 'x64' ? launcherManifest : launcherManifest.replace('0.9.0', '0.9.1')),
    }), /one identical runtime launcher manifest/);
    await assert.rejects(bundle(root, input, { readRuntimeManifest: async () => '{}' }), /app and UI images/);
  }));

  test('validates provenance inputs', () => withRoot(async root => {
    const input = await createFinalDirectory(root);
    await assert.rejects(bundle(root, input, { sourceSha: 'abc123' }), /full lowercase commit SHA/);
    await assert.rejects(bundle(root, input, { run: { ...run, id: '' } }), /positive integers/);
    await assert.rejects(bundle(root, input, { run: { ...run, serverUrl: 'http://github.com' } }), /HTTPS/);
  }));

  test('detects tampering with an assembled bundle', () => withRoot(async root => {
    const manifest = await bundle(root, await createFinalDirectory(root));
    const output = join(root, 'propr-desktop-nightly');
    await verifyNightlyBundle({ directory: output });
    await writeFile(join(output, manifest.artifacts[3].fileName), 'swapped\n');
    await assert.rejects(verifyNightlyBundle({ directory: output }), /does not match its manifest/);

    await mkdir(join(root, 'again'));
    await bundle(root, await createFinalDirectory(join(root, 'again')));
    await verifyNightlyBundle({ directory: output });
    const promoted = JSON.parse(await readFile(join(output, NIGHTLY_MANIFEST), 'utf8'));
    promoted.status.promotable = true;
    await writeFile(join(output, NIGHTLY_MANIFEST), JSON.stringify(promoted));
    await assert.rejects(verifyNightlyBundle({ directory: output }), /identity is invalid/);
  }));
});

describe('runtime binding', () => {
  test('reports unbound launcher pins and recognises only a validated digest-pinned source binding', () => {
    assert.equal(describeRuntimeBinding({ manifests: [{ contents: launcherManifest }], sourceSha }).binding, 'unbound');
    const bound = sha => JSON.stringify({
      git_sha: sha,
      images: { app: `propr/app:${sha}@sha256:${'1'.repeat(64)}`, ui: `propr/ui:${sha}@sha256:${'2'.repeat(64)}` },
      desktopRuntime: {
        schemaVersion: 1, distribution: 'published', sourceRevision: sha,
        apiCompatibility: '2026-01-01', desktopAuthenticationProtocol: 2,
      },
    });
    const aligned = describeRuntimeBinding({ manifests: [{ contents: bound(sourceSha) }], sourceSha });
    assert.equal(aligned.binding, 'source-aligned');
    assert.equal(aligned.currentSource, true);
    assert.equal(describeRuntimeBinding({ manifests: [{ contents: bound('b'.repeat(40)) }], sourceSha }).binding, 'other-source');
    const local = JSON.parse(bound(sourceSha));
    local.desktopRuntime.distribution = 'local';
    local.images = { app: `propr-desktop-local/app:${sourceSha}`, ui: `propr-desktop-local/ui:${sourceSha}` };
    const localBinding = describeRuntimeBinding({ manifests: [{ contents: JSON.stringify(local) }], sourceSha });
    assert.equal(localBinding.binding, 'invalid');
    assert.equal(localBinding.currentSource, false);
    assert.throws(() => describeRuntimeBinding({ manifests: [], sourceSha }), /one identical/);
  });

  test('never claims current source for bound metadata the canonical runtime validator rejects', () => {
    const other = 'b'.repeat(40);
    const agentImage = sha => `propr/agent:${sha}@sha256:${'3'.repeat(64)}`;
    const manifest = (overrides = {}) => {
      const value = JSON.parse(JSON.stringify({
        git_sha: sourceSha,
        images: { app: `propr/app:${sourceSha}@sha256:${'1'.repeat(64)}`, ui: `propr/ui:${sourceSha}@sha256:${'2'.repeat(64)}` },
        desktopRuntime: {
          schemaVersion: 1, distribution: 'published', sourceRevision: sourceSha,
          apiCompatibility: '2026-01-01', desktopAuthenticationProtocol: 2,
        },
      }));
      return JSON.stringify(overrides(value) ?? value);
    };
    const describe = contents => describeRuntimeBinding({ manifests: [{ contents }], sourceSha });
    const withAgent = (value, image, platforms = ['linux/amd64']) => {
      value.images.agent = image;
      value.desktopRuntime.managedAgent = { image, platforms };
      return value;
    };
    assert.equal(describe(manifest(value => withAgent(value, agentImage(sourceSha)))).binding, 'source-aligned');

    const rejected = {
      'git_sha and both image tags from another revision': value => {
        value.git_sha = other;
        value.images.app = `propr/app:${other}@sha256:${'1'.repeat(64)}`;
        value.images.ui = `propr/ui:${other}@sha256:${'2'.repeat(64)}`;
      },
      'git_sha from another revision': value => { value.git_sha = other; },
      'app image tag from another revision': value => { value.images.app = `propr/app:${other}@sha256:${'1'.repeat(64)}`; },
      'UI image from another repository': value => { value.images.ui = `propr/app:${sourceSha}@sha256:${'2'.repeat(64)}`; },
      'missing API compatibility': value => { delete value.desktopRuntime.apiCompatibility; },
      'local distribution': value => { value.desktopRuntime.distribution = 'local'; },
      'managed agent from another revision': value => withAgent(value, agentImage(other)),
      'managed agent not digest-pinned': value => withAgent(value, `propr/agent:${sourceSha}`),
      'managed agent with widened platforms': value => withAgent(value, agentImage(sourceSha), ['linux/amd64', 'linux/arm64']),
      'managed agent not mirrored in images': value => {
        withAgent(value, agentImage(sourceSha));
        value.images.agent = agentImage(other);
      },
    };
    for (const [name, override] of Object.entries(rejected)) {
      const result = describe(manifest(override));
      assert.equal(result.binding, 'invalid', name);
      assert.equal(result.currentSource, false, name);
      assert.match(result.bindingError, /Desktop runtime/, name);
    }
  });
});

describe('nightly run summary', () => {
  test('links the download and states readiness, signing, runtime, and limitations', () => withRoot(async root => {
    const manifest = await bundle(root, await createFinalDirectory(root));
    const summary = renderRunSummary({
      manifest,
      artifactUrl: 'https://github.com/integry/propr/actions/runs/38016752734/artifacts/123',
      artifactDigest: 'sha256:' + 'd'.repeat(64),
    });
    assert.match(summary, /\| Download \| \[propr-desktop-nightly-1\.2\.3-aaaaaaaaaaaa-run38016752734\.2-packaging-only\]\(https:\/\/github\.com\/integry\/propr\/actions\/runs\/38016752734\/artifacts\/123\) \|/);
    assert.match(summary, new RegExp(`\\[\`${sourceSha}\`\\]`));
    assert.match(summary, /\*\*Packaging-only download\. The nightly failed/);
    assert.match(summary, /\| Release-validation candidate \| no \|/);
    assert.match(summary, /\| Promotable \| no \|/);
    assert.match(summary, /\| Live E2E \(plan generation and model tasks\) \| ❌ failure \|/);
    assert.match(summary, /\| Linux runtime binding \| \*\*unbound\*\* \(not this source; see limitations\) \|/);
    assert.match(summary, /does not attest which source that backend runs/);
    assert.match(summary, /not a current-source end-to-end runtime build/);
    for (const artifact of manifest.artifacts) assert.ok(summary.includes(`| \`${artifact.fileName}\` | \`${artifact.sha256}\` |`));
    assert.doesNotMatch(summary, /fully validated|release-ready|ready to ship/i);
  }));

  test('explains a withheld bundle and keeps per-target artifacts as diagnostics only', () => {
    const summary = renderWithheldSummary({
      needs: needsWith({ 'desktop-package': { result: 'failure' } }),
      sourceSha,
      run,
      reason: 'Native packaging failed.',
    });
    assert.match(summary, /No consolidated download for this run\.\*\* Native packaging failed\./);
    assert.match(summary, /\| Native packaging, install lifecycle, and checksum finalization \| ❌ failure \|/);
    assert.match(summary, /diagnostics only/);
  });

  test('the gate command writes the withheld summary and exits non-zero', () => withRoot(async root => {
    const summaryPath = join(root, 'summary.md');
    const env = {
      ...process.env,
      NEEDS_JSON: needsWith({ 'desktop-package': { result: 'cancelled' } }),
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_SHA: sourceSha,
      GITHUB_REPOSITORY: run.repository,
      GITHUB_RUN_ID: run.id,
      GITHUB_RUN_ATTEMPT: run.attempt,
      GITHUB_SERVER_URL: run.serverUrl,
    };
    await assert.rejects(execFile(process.execPath, [script, 'gate'], { env }), error => error.code === 1);
    assert.match(await readFile(summaryPath, 'utf8'), /cancelled/);
    await execFile(process.execPath, [script, 'gate'], { env: { ...env, NEEDS_JSON: e2eFailed } });
  }));

  test('reports an uploaded but unsummarized bundle as available, not withheld', () => withRoot(async root => {
    const artifactName = 'propr-desktop-nightly-1.2.3-aaaaaaaaaaaa-run38016752734.2-packaging-only';
    const artifactUrl = 'https://github.com/integry/propr/actions/runs/38016752734/artifacts/123';
    const summary = renderUnsummarizedSummary({ artifactName, artifactUrl, artifactDigest: `sha256:${'d'.repeat(64)}`, sourceSha, run });
    assert.match(summary, /was uploaded, but its run summary could not be generated/);
    assert.ok(summary.includes(`[${artifactName}](${artifactUrl})`));
    assert.match(summary, new RegExp(`Read \`${NIGHTLY_MANIFEST}\` inside the download`));
    assert.doesNotMatch(summary, /withheld|No consolidated download|no verified download/i);

    const summaryPath = join(root, 'summary.md');
    await execFile(process.execPath, [script, 'unsummarized'], {
      env: {
        ...process.env,
        NIGHTLY_ARTIFACT_NAME: artifactName,
        NIGHTLY_ARTIFACT_URL: artifactUrl,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_SHA: sourceSha,
        GITHUB_REPOSITORY: run.repository,
        GITHUB_RUN_ID: run.id,
        GITHUB_RUN_ATTEMPT: run.attempt,
        GITHUB_SERVER_URL: run.serverUrl,
      },
    });
    const written = await readFile(summaryPath, 'utf8');
    assert.ok(written.includes(`[${artifactName}](${artifactUrl})`));
    assert.doesNotMatch(written, /withheld|No consolidated download/i);
  }));
});

describe('nightly download workflow wiring', () => {
  const readWorkflow = name => readFileSync(
    fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)), 'utf8',
  ).replace(/\r\n?/g, '\n');
  const nightly = readWorkflow('test-nightly.yml');
  const guard = readWorkflow('desktop-release-guard.yml');
  const jobBlock = (workflow, job) => {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.notEqual(start, -1, `${job} exists`);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
  };
  const download = jobBlock(nightly, 'desktop-nightly-download');
  const stepOrder = names => names.map(name => download.indexOf(`- name: ${name}\n`));

  test('runs after every nightly check, read-only, and without secrets or publication', () => {
    assert.match(download, /\n {4}needs: \[e2e-tests, native-electron, desktop-package, desktop-connect\]\n/);
    assert.match(download, /\n {4}if: \$\{\{ !cancelled\(\) \}\}\n/);
    assert.match(download, /\n {4}permissions:\n {6}contents: read\n {4}[a-z]/);
    assert.match(download, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
    assert.match(download, /DESKTOP_VERSION: \$\{\{ needs\.desktop-package\.outputs\.version \}\}/);
    assert.doesNotMatch(download, /secrets\.|contents: write|gh release|npm publish|docker push|git tag|git push|continue-on-error/);
    assert.match(download, /persist-credentials: false/);
  });

  test('gates on packaging, re-runs the shared finalize verification, then bundles, uploads, and summarizes', () => {
    const order = stepOrder([
      'Require native packaging success for the exact source',
      'Download all unsigned native artifacts',
      'Re-verify architecture, matrix completeness, and checksums',
      'Assemble nightly bundle with provenance manifest',
      'Upload consolidated nightly native bundle',
      'Publish nightly download summary',
      'Report withheld nightly bundle',
      'Report unsummarized nightly bundle',
    ]);
    assert.ok(order.every(index => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((left, right) => left - right), order);
    assert.match(download, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
    assert.match(download, /nightly-native-bundle\.mjs gate\n/);
    const finalize = jobBlock(guard, 'finalize');
    const pattern = 'pattern: propr-desktop-validation-canonical-*-${{ github.run_id }}';
    assert.ok(finalize.includes(pattern) && download.includes(pattern), 'the same canonical fragments are consumed');
    for (const block of [finalize, download]) {
      assert.match(block, /node apps\/desktop\/scripts\/release-artifacts\.mjs finalize \\\n\s+--version "\$\w+" \\\n\s+--profile macos-linux-v1 \\\n\s+--input desktop-release-fragments \\\n\s+--output desktop-release-final\n\s+\(cd desktop-release-final && sha256sum --check SHA256SUMS\)/);
    }
    assert.match(download, /name: \$\{\{ steps\.bundle\.outputs\.artifact_name \}\}\n\s+path: propr-desktop-nightly\n\s+if-no-files-found: error\n/);
    assert.match(download, /NIGHTLY_ARTIFACT_URL: \$\{\{ steps\.upload\.outputs\.artifact-url \}\}/);
    assert.match(download, /NIGHTLY_ARTIFACT_DIGEST: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/);
  });

  // Evaluates the two report conditions with GitHub's semantics: failure() is
  // true after a failed earlier step in this job or a failed ancestor job, and a
  // step skipped after a failure has outcome 'skipped'.
  test('reports a withheld bundle only when the upload did not succeed, even after upstream failures', () => {
    const condition = name => {
      const match = download.match(new RegExp(`- name: ${name}\\n\\s+if: ([^\\n]+)\\n`));
      assert.ok(match, name);
      return match[1];
    };
    const evaluate = (expression, { ancestorFailed, outcomes }) => expression.split(' && ').every(term => {
      if (term === 'failure()') return ancestorFailed || Object.values(outcomes).includes('failure');
      const step = term.match(/^steps\.(\w+)\.outcome (==|!=) '(\w+)'$/);
      assert.ok(step, `unsupported term: ${term}`);
      const [, id, operator, value] = step;
      assert.ok(id in outcomes, `unknown step: ${id}`);
      return (outcomes[id] === value) === (operator === '==');
    });
    const withheld = condition('Report withheld nightly bundle');
    const unsummarized = condition('Report unsummarized nightly bundle');
    assert.match(download, /- name: Publish nightly download summary\n\s+id: summary\n/);
    // The local steps that the conditions read; a failed step skips every later one.
    const order = ['gate', 'finalize', 'bundle', 'upload', 'summary'];
    const failingAt = step => Object.fromEntries(order.map((id, index) => {
      const at = order.indexOf(step);
      return [id, step === undefined || index < at ? 'success' : index === at ? 'failure' : 'skipped'];
    }));
    const scenarios = [
      // [failing local step, upstream failed, withheld runs, unsummarized runs]
      [undefined, true, false, false],
      [undefined, false, false, false],
      ['gate', true, false, false],
      ['finalize', true, true, false],
      ['finalize', false, true, false],
      ['bundle', true, true, false],
      ['upload', true, true, false],
      ['upload', false, true, false],
      ['summary', true, false, true],
      ['summary', false, false, true],
    ];
    for (const [step, ancestorFailed, expectWithheld, expectUnsummarized] of scenarios) {
      const state = { ancestorFailed, outcomes: failingAt(step) };
      const label = `${step ?? 'none'} failed locally, upstream ${ancestorFailed ? 'failed' : 'passed'}`;
      assert.equal(evaluate(withheld, state), expectWithheld, `withheld: ${label}`);
      assert.equal(evaluate(unsummarized, state), expectUnsummarized, `unsummarized: ${label}`);
    }
    assert.match(download, /- name: Report unsummarized nightly bundle\n[^]*?NIGHTLY_ARTIFACT_NAME: \$\{\{ steps\.bundle\.outputs\.artifact_name \}\}\n[^]*?nightly-native-bundle\.mjs unsummarized\n/);
  });

  test('pins every action to a SHA already reviewed in the nightly or desktop workflows', () => {
    const pins = text => [...text.matchAll(/uses: ([\w./-]+)@([a-f0-9]{40}) # v\d+/g)].map(match => `${match[1]}@${match[2]}`);
    const used = [...download.matchAll(/uses: (\S+)/g)].map(match => match[1]);
    assert.ok(used.length >= 3);
    const reviewed = new Set([...pins(nightly.replace(download, '')), ...pins(guard)]);
    for (const action of pins(download)) assert.ok(reviewed.has(action), action);
    assert.equal(pins(download).length, used.length, 'every action is SHA-pinned');
  });

  test('exposes only the validated version from the reusable desktop workflow and keeps health tracking', () => {
    const trigger = guard.slice(guard.indexOf('\non:\n'), guard.indexOf('\npermissions:\n'));
    assert.match(trigger, /\n {2}workflow_call:\n {4}# [^\n]+\n {4}# [^\n]+\n {4}outputs:\n {6}version:\n {8}description: [^\n]+\n {8}value: \$\{\{ jobs\.validation-version\.outputs\.version \}\}\n/);
    assert.doesNotMatch(trigger, /inputs:|secrets:/);
    assert.match(jobBlock(nightly, 'nightly-health'),
      /needs: \[e2e-tests, native-electron, desktop-package, desktop-connect, desktop-nightly-download\]/);
    assert.ok(jobBlock(nightly, 'desktop-package').includes('uses: ./.github/workflows/desktop-release-guard.yml'));
  });
});
