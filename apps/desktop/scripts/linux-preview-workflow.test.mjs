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

  test('stages a private draft and requires a separately authorized operation to publish a prerelease', () => {
    const stage = job('stage-draft', 'publish-draft');
    const publish = job('publish-draft');
    assert.match(stage, /if: inputs\.operation == 'stage-draft'/);
    assert.match(stage, /contents: write/);
    assert.match(stage, /stage-draft/);
    assert.doesNotMatch(stage, /publish-draft/);
    assert.match(publish, /if: inputs\.operation == 'publish-draft'/);
    assert.match(publish, /environment:\n\s+name: desktop-linux-preview-publication/);
    assert.match(publish, /PROPR_DESKTOP_LINUX_PREVIEW_PUBLICATION_AUTHORIZED/);
    assert.match(publish, /publish-draft/);
    assert.match(publish, /contents: write/);
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
