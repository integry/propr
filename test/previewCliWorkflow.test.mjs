import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parse } from 'yaml';
import { createPreviewPackage, writePreviewEvidence } from '../packages/cli/scripts/preview-package.mjs';
import { buildPreviewInput, operatorSummary, sourceReady, trust, validateDispatch, verifyOutput }
  from '../scripts/preview-cli-workflow.mjs';

const text = readFileSync('.github/workflows/preview-cli-bundle.yml', 'utf8');
const workflow = parse(text);
const job = workflow.jobs.prepare;
const steps = job.steps;
const runtimeWorkflow = readFileSync('.github/workflows/preview-runtime-images.yml', 'utf8');
const stepIndex = name => {
  const index = steps.findIndex(step => step.name === name || step.id === name);
  assert.ok(index >= 0, `missing step ${name}`);
  return index;
};
const stepUsing = action => steps.filter(step => step.uses?.startsWith(`${action}@`));
const digest = char => `sha256:${char.repeat(64)}`;
const images = source => Object.fromEntries(['app', 'ui', 'agent'].map((image, i) => [image, `propr/${image}:${source}@${digest('abc'[i])}`]));
const fixtures = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'preview-cli-workflow-')); fixtures.push(dir); return dir; };
afterEach(() => { while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true }); });

describe('Preview CLI Bundle workflow contract', () => {
  test('is manual-only with exactly the four required string inputs', () => {
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    const inputs = workflow.on.workflow_dispatch.inputs;
    assert.deepEqual(Object.keys(inputs).sort(), ['agent_image', 'app_image', 'source_revision', 'ui_image']);
    for (const input of Object.values(inputs)) assert.deepEqual([input.required, input.type, input.default], [true, 'string', undefined]);
  });

  test('refuses non-main or non-manual dispatch and malformed trusted SHA before any checkout', () => {
    const guard = steps[0];
    assert.equal(guard.uses, undefined);
    assert.deepEqual(guard.env, { DISPATCH_EVENT: '${{ github.event_name }}', DISPATCH_REF: '${{ github.ref }}', TRUSTED_MAIN: '${{ github.sha }}' });
    const run = env => spawnSync('bash', ['-c', guard.run], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    const good = { DISPATCH_EVENT: 'workflow_dispatch', DISPATCH_REF: 'refs/heads/main', TRUSTED_MAIN: 'a'.repeat(40) };
    assert.equal(run(good).status, 0);
    for (const bad of [{ DISPATCH_EVENT: 'push' }, { DISPATCH_EVENT: 'pull_request' }, { DISPATCH_REF: 'refs/heads/feature' },
      { DISPATCH_REF: 'refs/tags/v1' }, { TRUSTED_MAIN: 'A'.repeat(40) }, { TRUSTED_MAIN: 'a'.repeat(39) }, { TRUSTED_MAIN: '' }]) {
      assert.notEqual(run({ ...good, ...bad }).status, 0, JSON.stringify(bad));
    }
  });

  test('uses least privilege: contents read only, no environment, secrets, vars or credentials', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(workflow.jobs), ['prepare']);
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.equal(job.environment, undefined);
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.doesNotMatch(text, /secrets\.|vars\.|github\.token|GITHUB_TOKEN|NPM_TOKEN|DOCKERHUB|NODE_AUTH_TOKEN|_API_KEY/);
    assert.doesNotMatch(text, /continue-on-error|if:/, 'every step must fail closed and gate the next');
  });

  test('pins every third-party action to the reviewed full SHAs used by Preview Runtime Images', () => {
    for (const step of steps.filter(step => step.uses)) {
      assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, step.uses);
      assert.ok(runtimeWorkflow.includes(`uses: ${step.uses}`), `${step.uses} must match the reviewed runtime workflow pin`);
    }
    const [regctl] = stepUsing('regclient/actions/regctl-installer');
    assert.deepEqual(regctl.with, { release: 'v0.11.5' });
    const [node] = stepUsing('actions/setup-node');
    assert.deepEqual(node.with, { 'node-version': '22', architecture: 'x64', 'package-manager-cache': false });
  });

  test('checks out canonical full history without credentials and proves ancestry before source code runs', () => {
    const [trusted, source] = stepUsing('actions/checkout');
    assert.equal(stepUsing('actions/checkout').length, 2);
    assert.deepEqual(trusted.with, { repository: 'integry/propr', ref: '${{ github.sha }}', path: 'trusted', 'fetch-depth': 0, 'persist-credentials': false });
    assert.deepEqual(source.with, { repository: 'integry/propr', ref: '${{ steps.trust.outputs.source_revision }}', path: 'source', 'fetch-depth': 0, 'persist-credentials': false });
    const order = ['Checkout the trusted main workflow commit with full history', 'trust',
      'Checkout the exact validated source with no persisted credential',
      'Require a clean canonical source checkout and pin origin/main to the trusted commit',
      'Install the pinned workspace build dependencies without lifecycle scripts',
      'Verify runtime images, build, pack and smoke the preview CLI', 'verify',
      'Retain the completed bundle as a run-specific artifact', 'Summarize the prepared bundle for the operator'].map(stepIndex);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    // Before the build, only trusted-main helpers run; nothing executes from source/.
    for (const step of steps.slice(0, stepIndex('Install the pinned workspace build dependencies without lifecycle scripts'))) {
      assert.equal(step['working-directory'], undefined, step.name);
      for (const script of step.run?.match(/\S+\.mjs/g) ?? []) assert.equal(script, 'trusted/scripts/preview-cli-workflow.mjs', step.name);
    }
  });

  test('propagates exact inputs through env only and runs the helper with the trusted main SHA', () => {
    for (const step of steps.filter(step => step.run)) assert.doesNotMatch(step.run, /\$\{\{/, `${step.name} must not interpolate expressions into shell`);
    const gate = steps[stepIndex('trust')];
    assert.deepEqual(gate.env, {
      DISPATCH_EVENT: '${{ github.event_name }}', DISPATCH_REF: '${{ github.ref }}', DISPATCH_REPOSITORY: '${{ github.repository }}',
      TRUSTED_MAIN: '${{ github.sha }}', SOURCE_REVISION: '${{ inputs.source_revision }}', APP_IMAGE: '${{ inputs.app_image }}',
      UI_IMAGE: '${{ inputs.ui_image }}', AGENT_IMAGE: '${{ inputs.agent_image }}',
    });
    for (const flag of ['--source-revision "$SOURCE_REVISION"', '--app-image "$APP_IMAGE"', '--ui-image "$UI_IMAGE"', '--agent-image "$AGENT_IMAGE"',
      '--trusted-main "$TRUSTED_MAIN"', '--output "$RUNNER_TEMP/propr-cli-preview-input.json"']) assert.ok(gate.run.includes(flag), flag);
    const build = steps[stepIndex('Verify runtime images, build, pack and smoke the preview CLI')];
    assert.equal(build['working-directory'], 'source');
    assert.equal(build.env, undefined, 'GITHUB_REF and GITHUB_SHA must reach the helper unchanged');
    assert.ok(build.run.includes('node packages/cli/scripts/build-publish.mjs --preview-input "$RUNNER_TEMP/propr-cli-preview-input.json" --trusted-main "$GITHUB_SHA"'));
    assert.equal(steps[stepIndex('Install the pinned workspace build dependencies without lifecycle scripts')].run, 'npm ci --ignore-scripts --no-audit --no-fund');
    assert.ok(steps.every(step => !step.env || !('GITHUB_REF' in step.env || 'GITHUB_SHA' in step.env)));
  });

  test('uploads only the verified completed directory as a 60-day run-specific artifact', () => {
    const [upload] = stepUsing('actions/upload-artifact');
    assert.equal(stepUsing('actions/upload-artifact').length, 1);
    assert.deepEqual(upload.with, {
      name: 'propr-cli-preview-${{ steps.trust.outputs.source_revision }}-${{ github.run_id }}',
      path: '${{ steps.verify.outputs.artifact_path }}/', 'if-no-files-found': 'error', 'retention-days': 60, overwrite: false,
    });
    assert.equal(upload.if, undefined, 'a failed earlier step must skip the upload');
  });

  test('contains no publication, stable fallback or live infrastructure path', () => {
    for (const forbidden of [/npm publish/, /--publish/, /docker (push|login|buildx)/, /regctl image copy/, /gh release/, /git (push|tag)/,
      /:latest|:beta|npm\/latest|dist-tag/, /wrangler|tofu|terraform|ssh |propr-fleet|routing/i, /environment:/, /download-artifact/]) {
      assert.doesNotMatch(text, forbidden);
    }
  });
});

describe('preview CLI workflow trust helper', () => {
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = () => {
    const dir = fixture();
    run(dir, 'init', '-q', '-b', 'main');
    run(dir, 'config', 'user.email', 't@example.com');
    run(dir, 'config', 'user.name', 'Test');
    run(dir, 'remote', 'add', 'origin', 'https://github.com/integry/propr');
    const commit = message => { writeFileSync(join(dir, 'f'), message); run(dir, 'add', 'f'); run(dir, 'commit', '-qm', message); return run(dir, 'rev-parse', 'HEAD'); };
    const source = commit('source');
    const main = commit('main');
    run(dir, 'checkout', '-q', '-b', 'side', source);
    const side = commit('side');
    run(dir, 'checkout', '-q', main);
    run(dir, 'update-ref', 'refs/remotes/origin/main', main);
    return { dir, source, main, side };
  };
  const dispatch = main => ({ eventName: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'integry/propr', trustedMain: main });

  test('writes the exact schema-v1 preview input only after every gate passes', () => {
    const { dir, source, main } = repo();
    const output = join(fixture(), 'input.json');
    const githubOutput = join(fixture(), 'out');
    trust({ ...dispatch(main), sourceRevision: source, ...images(source), root: dir, output, githubOutput });
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')),
      { schemaVersion: 1, repository: 'integry/propr', sourceRevision: source, images: images(source) });
    assert.equal(readFileSync(githubOutput, 'utf8'), `source_revision=${source}\ntrusted_main=${main}\n`);
    const same = join(fixture(), 'input.json');
    trust({ ...dispatch(main), sourceRevision: main, ...images(main), root: dir, output: same });
    assert.throws(() => trust({ ...dispatch(main), sourceRevision: main, ...images(main), root: dir, output: same }), /must be new/);
  });

  test('refuses bad dispatch, malformed SHAs, non-ancestors, non-canonical origins and bad image references', () => {
    const { dir, source, main, side } = repo();
    const base = { ...dispatch(main), sourceRevision: source, ...images(source), root: dir };
    const refusals = [
      { eventName: 'push' }, { eventName: 'schedule' }, { ref: 'refs/heads/feature' }, { repository: 'fork/propr' },
      { trustedMain: main.toUpperCase() }, { trustedMain: main.slice(0, 12) }, { trustedMain: side },
      { sourceRevision: source.slice(0, 12) }, { sourceRevision: source.toUpperCase() }, { sourceRevision: side, ...images(side) },
      { app: `propr/app:${source}` }, { ui: `propr/ui:latest@${digest('b')}` }, { agent: `propr/agent:${side}@${digest('c')}` },
      { app: `other/app:${source}@${digest('a')}` }, { ui: `propr/app:${source}@${digest('b')}` }, { agent: `propr/agent:${source}@sha256:${'C'.repeat(64)}` },
      { app: `propr/app:${source}@sha256:1234` }, { app: `docker.io/propr/app:${source}@${digest('a')}` }, { ui: ` propr/ui:${source}@${digest('b')}` },
      { agent: undefined },
    ];
    for (const change of refusals) {
      const output = join(fixture(), 'input.json');
      assert.throws(() => trust({ ...base, ...change, output }), undefined, JSON.stringify(change));
      assert.equal(existsSync(output), false, 'no preview input may be written on refusal');
    }
    run(dir, 'remote', 'set-url', 'origin', 'https://github.com/fork/propr');
    assert.throws(() => trust({ ...base, output: join(fixture(), 'input.json') }), /canonical/);
  });

  test('requires a full-history trusted checkout', () => {
    const { dir, source, main } = repo();
    const shallow = join(fixture(), 'shallow');
    run(fixture(), 'clone', '-q', '--depth', '1', `file://${dir}`, shallow);
    run(shallow, 'remote', 'set-url', 'origin', 'https://github.com/integry/propr.git');
    assert.throws(() => trust({ ...dispatch(main), sourceRevision: source, ...images(source), root: shallow,
      output: join(fixture(), 'input.json') }), /full history/);
  });

  test('source checkout must be exact, canonical and clean; origin/main is pinned to the trusted commit', () => {
    const { dir, source, main, side } = repo();
    run(dir, 'checkout', '-q', '--detach', source);
    assert.throws(() => sourceReady({ root: dir, sourceRevision: main, trustedMain: main }), /HEAD/);
    assert.throws(() => sourceReady({ root: dir, sourceRevision: source, trustedMain: side }), /origin\/main/);
    writeFileSync(join(dir, 'untracked'), 'x');
    assert.throws(() => sourceReady({ root: dir, sourceRevision: source, trustedMain: main }), /clean/);
    rmSync(join(dir, 'untracked'));
    run(dir, 'update-ref', 'refs/remotes/origin/main', source);
    assert.throws(() => sourceReady({ root: dir, sourceRevision: source, trustedMain: main }), /does not contain/);
    // Main advanced after dispatch: origin/main is re-pinned to the workflow commit.
    run(dir, 'update-ref', 'refs/remotes/origin/main', main);
    sourceReady({ root: dir, sourceRevision: source, trustedMain: source });
    assert.equal(run(dir, 'rev-parse', 'refs/remotes/origin/main'), source);
  });

  test('validateDispatch and buildPreviewInput are fail-closed pure gates', () => {
    assert.equal(validateDispatch(dispatch('a'.repeat(40))), 'a'.repeat(40));
    assert.throws(() => validateDispatch({ ...dispatch('a'.repeat(40)), eventName: 'workflow_call' }));
    assert.throws(() => buildPreviewInput({ sourceRevision: 'a'.repeat(40), ...images('a'.repeat(40)), app: undefined }));
  });
});

describe('preview CLI workflow output verification', () => {
  const source = 'd'.repeat(40);
  const trustedMain = 'e'.repeat(40);
  const sha = value => createHash('sha256').update(value).digest('hex');
  const bound = createPreviewPackage('1.2.3', { schemaVersion: 1, repository: 'integry/propr', sourceRevision: source, images: images(source) }).version;
  const completed = (edit = () => {}, version = bound) => {
    const root = fixture();
    mkdirSync(join(root, 'packages/cli'), { recursive: true });
    writeFileSync(join(root, 'packages/cli/package.json'), JSON.stringify({ version: '1.2.3' }));
    const directory = join(root, 'dist-publish/preview', version);
    mkdirSync(directory, { recursive: true });
    const tarball = `propr-cli-${version}.tgz`;
    const files = { [tarball]: 'tarball', 'manifest.json': JSON.stringify({ version, git_sha: source, images: images(source) }) };
    const state = { root, directory, version, tarball, files, provenance: {
      schemaVersion: 1, repository: 'integry/propr', sourceRevision: source, trustedMain, cliVersion: version,
      images: Object.fromEntries(Object.entries(images(source)).map(([k, reference]) => [k, { reference }])),
      files: { [tarball]: sha('tarball'), 'manifest.json': sha(files['manifest.json']) },
    } };
    edit(state);
    for (const [file, body] of Object.entries(state.files)) writeFileSync(join(directory, file), body);
    const provenance = JSON.stringify(state.provenance);
    writeFileSync(join(directory, 'provenance.json'), provenance);
    const sums = { [tarball]: sha(state.files[tarball] ?? ''), 'manifest.json': sha(state.files['manifest.json'] ?? ''), 'provenance.json': sha(provenance) };
    writeFileSync(join(directory, 'SHA256SUMS'), Object.entries(sums).map(([file, hash]) => `${hash}  ${file}\n`).join(''));
    const input = join(fixture(), 'input.json');
    writeFileSync(input, JSON.stringify({ schemaVersion: 1, repository: 'integry/propr', sourceRevision: source, images: images(source) }));
    return { ...state, input };
  };

  test('accepts one complete bound directory and emits the fixed operator summary', () => {
    const state = completed();
    const result = verifyOutput({ root: state.root, input: state.input, trustedMain, workspace: state.root });
    assert.equal(result.artifactPath, join('dist-publish/preview', state.version));
    assert.equal(result.tarballSha256, sha('tarball'));
    const summary = operatorSummary(result);
    for (const value of [state.version, source, trustedMain, state.tarball, sha('tarball'), result.manifestSha256, result.provenanceSha256,
      ...Object.values(images(source))]) assert.ok(summary.includes(value), value);
    assert.doesNotMatch(summary, /latest|beta|token|secret/i);
    execFileSync('sha256sum', ['--check', 'SHA256SUMS'], { cwd: state.directory, stdio: 'pipe' });
  });

  test('accepts the evidence layout written by the real preview helper', () => {
    const root = fixture();
    mkdirSync(join(root, 'packages/cli'), { recursive: true });
    writeFileSync(join(root, 'packages/cli/package.json'), JSON.stringify({ version: '1.2.3' }));
    const input = { schemaVersion: 1, repository: 'integry/propr', sourceRevision: source, images: images(source) };
    const verified = Object.fromEntries(Object.entries(images(source)).map(([image, reference]) =>
      [image, { reference, platforms: image === 'agent' ? ['linux/amd64'] : ['linux/amd64', 'linux/arm64'] }]));
    const preview = createPreviewPackage('1.2.3', input, verified);
    const directory = join(root, 'dist-publish/preview', preview.version);
    mkdirSync(directory, { recursive: true });
    const tarball = `propr-cli-${preview.version}.tgz`;
    writeFileSync(join(directory, tarball), 'tarball');
    writePreviewEvidence(directory, tarball, preview, trustedMain, { ok: true });
    const inputPath = join(fixture(), 'input.json');
    writeFileSync(inputPath, JSON.stringify(input));
    assert.equal(verifyOutput({ root, input: inputPath, trustedMain }).version, preview.version);
    assert.throws(() => verifyOutput({ root, input: inputPath, trustedMain: source }), /provenance/);
  });

  test('refuses missing, partial, duplicate, tampered or unbound output', () => {
    const empty = fixture();
    mkdirSync(join(empty, 'packages/cli'), { recursive: true });
    writeFileSync(join(empty, 'packages/cli/package.json'), JSON.stringify({ version: '1.2.3' }));
    const input = completed().input;
    assert.throws(() => verifyOutput({ root: empty, input, trustedMain }), /found 0/);
    for (const [label, edit, after = () => {}, pattern] of [
      ['second completed directory', () => {}, s => mkdirSync(join(s.root, 'dist-publish/preview', `1.2.3-preview.${source}.${'0'.repeat(64)}`)), /found 2/],
      ['leftover partial directory', () => {}, s => mkdirSync(join(s.root, 'dist-publish/preview/.prepare-x')), /found 2/],
      ['missing tarball', s => { delete s.files[s.tarball]; }, () => {}, /exactly/],
      ['extra file', () => {}, s => writeFileSync(join(s.directory, 'extra'), ''), /exactly/],
      ['tampered tarball', () => {}, s => writeFileSync(join(s.directory, s.tarball), 'other'), /SHA256SUMS/],
      ['wrong trusted main', s => { s.provenance.trustedMain = 'f'.repeat(40); }, () => {}, /provenance/],
      ['wrong runtime reference', s => { s.provenance.images.agent.reference = `propr/agent:${source}@${digest('9')}`; }, () => {}, /provenance/],
      ['manifest fallback', s => { s.files['manifest.json'] = JSON.stringify({ version: s.version, git_sha: source, images: { ...images(source), docs: 'propr/docs:latest' } }); }, () => {}, /manifest/],
    ]) {
      const state = completed(edit);
      after(state);
      assert.throws(() => verifyOutput({ root: state.root, input: state.input, trustedMain }), pattern, label);
    }
    const wrongSource = completed();
    const other = { schemaVersion: 1, repository: 'integry/propr', sourceRevision: 'c'.repeat(40), images: images('c'.repeat(40)) };
    writeFileSync(wrongSource.input, JSON.stringify(other));
    assert.throws(() => verifyOutput({ root: wrongSource.root, input: wrongSource.input, trustedMain }), /Unexpected preview directory/);
    // A self-consistent directory whose suffix is not the runtime-reference binding.
    for (const suffix of ['f'.repeat(64), bound.slice(-64).replace(/.$/, c => (c === '0' ? '1' : '0'))]) {
      const wrongBinding = completed(() => {}, `1.2.3-preview.${source}.${suffix}`);
      assert.throws(() => verifyOutput({ root: wrongBinding.root, input: wrongBinding.input, trustedMain }), /Unexpected preview directory/);
    }
  });

  test('CLI refusal writes no step outputs or summary, so the upload has no path', () => {
    const state = completed(s => { s.provenance.cliVersion = 'x'; });
    const out = join(fixture(), 'out');
    const summary = join(fixture(), 'summary.md');
    const result = spawnSync(process.execPath, ['scripts/preview-cli-workflow.mjs', 'verify-output', '--root', state.root, '--input', state.input,
      '--trusted-main', trustedMain, '--github-output', out, '--summary', summary], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(out) || existsSync(summary), false);
    const good = completed();
    const ok = spawnSync(process.execPath, ['scripts/preview-cli-workflow.mjs', 'verify-output', '--root', good.root, '--input', good.input,
      '--trusted-main', trustedMain, '--github-output', out, '--summary', summary], { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(readFileSync(out, 'utf8'), new RegExp(`^version=${good.version.replaceAll('.', '\\.')}\nartifact_path=.+${good.version.replaceAll('.', '\\.')}\n$`));
    assert.ok(readFileSync(summary, 'utf8').startsWith('### Preview CLI bundle prepared (prepare-only)'));
  });
});
