import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/docker-images.yml', 'utf8'));
const job = workflow.jobs['publish-github-release'];
const step = name => {
  const found = job.steps.find(candidate => candidate.name === name);
  assert.ok(found, `missing step ${name}`);
  return found;
};
const publish = step('Create or update GitHub release');

// Runs the publish step against a stub gh that records its arguments.
function runPublish({ releaseExists, notes }) {
  const dir = mkdtempSync(join(tmpdir(), 'github-release-publish-'));
  try {
    const bin = join(dir, 'bin');
    const calls = join(dir, 'calls');
    mkdirSync(bin);
    mkdirSync(join(dir, 'release-artifacts'));
    writeFileSync(join(dir, 'release-artifacts', 'propr-cli-1.2.3.tgz'), 'tarball');
    if (notes !== undefined) {
      mkdirSync(join(dir, 'release-source', 'release-notes'), { recursive: true });
      writeFileSync(join(dir, 'release-source', 'release-notes', 'v1.2.3.md'), notes);
    }
    writeFileSync(join(bin, 'gh'), [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
      `if [ "$1 $2" = "release view" ]; then exit ${releaseExists ? 0 : 1}; fi`,
      'exit 0',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);
    const run = publish.run.replaceAll('${{ github.repository }}', 'integry/propr');
    const result = spawnSync('bash', ['-e', '-c', run], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, RELEASE_TAG: 'v1.2.3' },
      encoding: 'utf8',
    });
    let recorded = '';
    try { recorded = readFileSync(calls, 'utf8'); } catch { /* gh never ran */ }
    return { ...result, calls: recorded.trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('GitHub release publication workflow contract', () => {
  test('reads the release summary from the verified release tag, not main', () => {
    const steps = job.steps.map(candidate => candidate.name);
    assert.deepEqual(steps, ['Checkout release notes', 'Download CLI artifact', 'Create or update GitHub release']);
    const checkout = step('Checkout release notes');
    assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.deepEqual(checkout.with, {
      ref: '${{ needs.validate-release.outputs.release_tag }}',
      path: 'release-source',
      'sparse-checkout': 'release-notes',
      'persist-credentials': false,
    });
    assert.deepEqual(job.needs, ['validate-release', 'build-smoke-and-push', 'publish-cli']);
    assert.deepEqual(job.permissions, { contents: 'write' });
    assert.equal(publish.env.RELEASE_TAG, '${{ needs.validate-release.outputs.release_tag }}');
  });

  test('a new release gets the checked-in summary first and the generated list after it', () => {
    const result = runPublish({ releaseExists: false, notes: '## Highlights\n\nThings.\n\n## Upgrade notes\n\nNone.\n' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0], 'release view v1.2.3 --repo integry/propr');
    assert.equal(result.calls[1], [
      'release create v1.2.3 release-artifacts/propr-cli-1.2.3.tgz',
      '--repo integry/propr --verify-tag',
      '--notes-file release-source/release-notes/v1.2.3.md --generate-notes',
      '--title ProPR v1.2.3',
    ].join(' '));
  });

  test('refuses to create a release without its summary file', () => {
    for (const notes of [undefined, '']) {
      const result = runPublish({ releaseExists: false, notes });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /release-source\/release-notes\/v1\.2\.3\.md is missing or empty in v1\.2\.3/);
      assert.deepEqual(result.calls, ['release view v1.2.3 --repo integry/propr']);
    }
  });

  test('an existing release only gets its assets uploaded', () => {
    for (const notes of [undefined, '## Highlights\n']) {
      const result = runPublish({ releaseExists: true, notes });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.calls, [
        'release view v1.2.3 --repo integry/propr',
        'release upload v1.2.3 release-artifacts/propr-cli-1.2.3.tgz --clobber --repo integry/propr',
      ]);
    }
  });
});
