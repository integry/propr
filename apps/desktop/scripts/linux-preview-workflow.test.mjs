import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const workflow = await readFile(
  new URL('../../../.github/workflows/desktop-linux-preview.yml', import.meta.url),
  'utf8',
);

const job = (name, next) => {
  const start = workflow.indexOf(`\n  ${name}:`);
  const end = next ? workflow.indexOf(`\n  ${next}:`, start + 1) : workflow.length;
  assert.notEqual(start, -1, `missing ${name} job`);
  assert.notEqual(end, -1, `missing ${next} job`);
  return workflow.slice(start, end);
};

describe('desktop Linux preview workflow', () => {
  test('is manual-only, main-dispatched, Linux-only, and independent of protected production credentials', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/m);
    assert.match(job('identity', 'runtime-preflight'), /DISPATCH_REF.*github\.ref/);
    assert.match(job('identity', 'runtime-preflight'), /refs\/heads\/main/);
    assert.match(job('identity', 'runtime-preflight'), /WORKFLOW_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(job('identity', 'runtime-preflight'), /merge-base --is-ancestor "\$REQUESTED_SHA" "\$WORKFLOW_SHA"/);
    assert.equal(workflow.match(/runner: ubuntu-24\.04(?:-arm)?/g)?.length, 2);
    assert.doesNotMatch(workflow, /runs-on: (?:macos|windows)/);
    assert.doesNotMatch(workflow, /secrets\./);
    assert.doesNotMatch(workflow, /environment:\n\s+name: desktop-release(?:\n|$)/);
    assert.doesNotMatch(workflow, /PROPR_DESKTOP_ENABLE_UPDATES=1|PROPR_DESKTOP_PRODUCTION_RELEASE=1/);
  });

  test('builds the exact x64/arm64 DEB/RPM profile with source-aligned published runtime images', () => {
    const packageJob = job('package', 'finalize');
    assert.match(workflow, /verify-release/);
    assert.match(workflow, /propr\/app:\$\{REQUESTED_SHA\}@sha256:/);
    assert.match(workflow, /propr\/ui:\$\{REQUESTED_SHA\}@sha256:/);
    assert.match(packageJob, /- arch: x64\n\s+runner: ubuntu-24\.04/);
    assert.match(packageJob, /- arch: arm64\n\s+runner: ubuntu-24\.04-arm/);
    assert.match(packageJob, /PROPR_DESKTOP_ENABLE_DEB=1 PROPR_DESKTOP_ENABLE_RPM=1/);
    assert.match(packageJob, /--profile linux-preview-v1/);
    assert.doesNotMatch(packageJob, /test-native-artifact-lifecycle|installed-app|acceptance/);
  });

  test('requires, verifies, and embeds an explicit same-source linux/amd64 managed agent for new previews', () => {
    const identity = job('identity', 'runtime-preflight');
    const preflight = job('runtime-preflight', 'package');
    const packageJob = job('package', 'finalize');
    const finalize = job('finalize', 'stage-draft');
    assert.match(workflow, /runtime_agent_image:\n\s+description: Stage only - propr\/agent:<source SHA>@sha256:<digest> published linux\/amd64/);
    assert.match(identity, /agent_pattern="propr\/agent:\$\{REQUESTED_SHA\}@sha256:"/);
    assert.match(identity, /\[\[ "\$RUNTIME_AGENT_IMAGE" =~ \^\$\{agent_pattern\}\[a-f0-9\]\{64\}\$ \]\] \|\| \{/);
    assert.match(identity, /echo "runtime_agent_image=\$RUNTIME_AGENT_IMAGE"/);
    assert.match(preflight, /--agent-image "\$RUNTIME_AGENT_IMAGE"/);
    assert.match(packageJob, /desktop-runtime-manifest\.mjs release[\s\S]+--agent-image "\$RUNTIME_AGENT_IMAGE"/);
    assert.match(packageJob, /PROPR_DESKTOP_RUNTIME_AGENT_IMAGE: \$\{\{ needs\.identity\.outputs\.runtime_agent_image \}\}/);
    assert.match(packageJob, /resources\/manifest\.json"[\s\S]+agentImage: process\.env\.RUNTIME_AGENT_IMAGE/);
    assert.match(finalize, /--runtime-agent-image "\$RUNTIME_AGENT_IMAGE"/);
    // The packages stay x64/arm64; the agent image's architecture limit is not
    // satisfied by narrowing or widening the desktop package matrix.
    assert.match(packageJob, /- arch: x64\n[\s\S]+- arch: arm64\n/);
  });

  test('unsigned staging has no public publication route', () => {
    const stage = job('stage-draft');
    assert.match(stage, /if: inputs\.operation == 'stage-draft'/);
    assert.match(stage, /contents: write/);
    assert.match(stage, /stage-draft/);
    assert.doesNotMatch(workflow, /publish-draft|desktop-linux-preview-publication/);
  });

  test('finalizes architecture-labelled assets and a SHA256 preview manifest without trusted update metadata', () => {
    const finalize = job('finalize', 'stage-draft');
    assert.match(finalize, /release-artifacts\.mjs finalize/);
    assert.match(finalize, /linux-preview-release\.mjs prepare/);
    assert.match(finalize, /sha256sum --check SHA256SUMS/);
    assert.match(finalize, /test ! -e desktop-linux-preview-final\/desktop-release\.json/);
    assert.match(finalize, /test ! -e desktop-linux-preview-final\/desktop-release\.json\.sig/);
  });
});

const signedWorkflow = await readFile(
  new URL('../../../.github/workflows/desktop-linux-signed-preview.yml', import.meta.url), 'utf8',
);
const signedJob = (name, next) => signedWorkflow.slice(signedWorkflow.indexOf(`\n  ${name}:`),
  next ? signedWorkflow.indexOf(`\n  ${next}:`) : undefined);

describe('protected authenticated Linux preview workflow', () => {
  test('is explicitly manual and main-only with frozen source and exact run provenance', () => {
    assert.match(signedWorkflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(signedWorkflow, /^  (?:push|pull_request|pull_request_target|workflow_run|schedule):/m);
    const identity = signedJob('identity', 'sign');
    assert.match(identity, /github.ref == 'refs\/heads\/main'/);
    assert.match(identity, /merge-base --is-ancestor "\$SOURCE_REVISION" HEAD/);
    assert.match(identity, /run.event !== 'workflow_dispatch'/);
    assert.match(identity, /run.path !== '.github\/workflows\/desktop-linux-preview.yml'/);
    assert.match(identity, /run.head_branch !== 'main'/);
    assert.match(identity, /run.conclusion !== 'success'/);
    assert.match(identity, /run.repository.full_name !== process.env.REPOSITORY/);
    assert.doesNotMatch(signedWorkflow, /make_latest: true|ENABLE_UPDATES|PRODUCTION_RELEASE/);
  });

  test('confines private credentials to the protected read-only signing job and step', () => {
    const sign = signedJob('sign', 'stage-draft');
    assert.match(sign, /environment:\n\s+name: desktop-linux-rpm-signing/);
    assert.match(sign, /PROPR_DESKTOP_RPM_SIGNING_AUTHORIZED/);
    assert.match(sign, /contents: read\n\s+actions: read/);
    assert.match(sign, /ref: \$\{\{ github.sha \}\}/);
    assert.match(sign, /ref: \$\{\{ inputs.source_revision \}\}\n\s+path: frozen-source/);
    assert.match(sign, /secrets.PROPR_DESKTOP_RPM_PRIVATE_KEY/);
    assert.match(sign, /secrets.PROPR_DESKTOP_RPM_PASSPHRASE/);
    assert.equal(signedWorkflow.match(/secrets\./g)?.length, 2);
    assert.doesNotMatch(signedJob('identity', 'sign') + signedJob('stage-draft'), /secrets\./);
    assert.doesNotMatch(workflow, /secrets\./);
    assert.match(sign, /sign-bundle --signed-linux/);
    assert.match(sign, /manifest.workflowRunId !== process.env.UNSIGNED_RUN_ID/);
    assert.match(sign, /name: \$\{\{ needs.identity.outputs.unsigned_artifact \}\}/);
    assert.doesNotMatch(sign, /pattern:/);
  });

  test('stages only final signed bytes and re-verifies with public inputs on publication', () => {
    const stage = signedJob('stage-draft', 'publish-draft');
    const publish = signedJob('publish-draft');
    assert.match(stage, /name: propr-desktop-linux-signed-\$\{\{ github.run_id \}\}/);
    assert.match(stage, /stage-draft --signed-linux/);
    assert.match(publish, /publish-draft --signed-linux/);
    for (const block of [stage, publish]) {
      assert.match(block, /PROPR_DESKTOP_RPM_PUBLIC_KEY/);
      assert.match(block, /PROPR_DESKTOP_RPM_FINGERPRINT/);
      assert.match(block, /--source-directory frozen-source/);
      assert.doesNotMatch(block, /unsigned-preview|pattern:/);
    }
    assert.match(publish, /name: desktop-linux-preview-publication/);
    assert.match(publish, /PROPR_DESKTOP_LINUX_PREVIEW_PUBLICATION_AUTHORIZED/);
  });
});

test('regular desktop PR validation requires disposable-key and real RPM tests', async () => {
  const guard = await readFile(new URL('../../../.github/workflows/desktop-release-guard.yml', import.meta.url), 'utf8');
  assert.match(guard, /^  pull_request:/m);
  const start = guard.indexOf('\n  validation-version:');
  const block = guard.slice(start, guard.indexOf('\n  renderer-axe-boundary:', start));
  assert.match(block, /github.event_name != 'push'/);
  assert.match(block, /needs.classify.outputs.desktop != 'false'/);
  assert.match(block, /runs-on: ubuntu-latest/);
  assert.match(block, /sudo apt-get install --yes rpm gnupg cpio/);
  assert.match(block, /PROPR_REQUIRE_RPM_TESTS: '1'/);
  assert.match(block, /node --test apps\/desktop\/scripts\/rpm-signing.test.mjs/);
  assert.doesNotMatch(block, /continue-on-error|secrets\.|environment:/);
  assert.ok(block.indexOf('sudo apt-get install') < block.indexOf('node --test'));
});

test('signed preview requires installed x64 RPM gate and exact-run acceptance evidence on publication', () => {
  const acceptance = signedJob('installed-rpm-acceptance', 'stage-draft');
  assert.match(acceptance, /needs: \[identity, sign\]/);
  assert.match(acceptance, /name: propr-desktop-linux-signed-\$\{\{ github.run_id \}\}/);
  assert.match(acceptance, /run-signed-installed-rpm-acceptance.mjs/);
  assert.match(acceptance, /name: propr-desktop-installed-signed-rpm-\$\{\{ github.run_id \}\}/);
  assert.doesNotMatch(acceptance, /secrets\.|contents: write|continue-on-error/);
  assert.match(signedJob('stage-draft', 'publish-draft'), /needs: \[identity, sign, installed-rpm-acceptance\]/);
  const publish = signedJob('publish-draft');
  assert.match(publish, /run-id: \$\{\{ inputs.signing_run_id \}\}/);
  assert.match(publish, /name: propr-desktop-installed-signed-rpm-\$\{\{ inputs.signing_run_id \}\}/);
  assert.match(publish, /--acceptance-evidence signed-rpm-acceptance\/signed-rpm-acceptance.json/);
  assert.match(publish, /--signing-run-id/);
});

test('signed RPM acceptance installs locked workspace dependencies before loading the runner', () => {
  const acceptance = signedJob('installed-rpm-acceptance', 'stage-draft');
  const checkout = acceptance.indexOf('uses: actions/checkout@');
  const setupNode = acceptance.indexOf('uses: actions/setup-node@');
  const install = acceptance.indexOf('run: npm ci --ignore-scripts --no-audit --no-fund');
  const runner = acceptance.indexOf('node apps/desktop/scripts/run-signed-installed-rpm-acceptance.mjs');
  assert.match(acceptance, /node-version-file: '\.nvmrc'/);
  assert.ok(checkout >= 0 && setupNode > checkout && install > setupNode && runner > install,
    'a fresh checkout must install lockfile-pinned dependencies under the configured Node version before acceptance');
});
