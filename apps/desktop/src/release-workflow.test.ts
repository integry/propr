import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const workflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/desktop-release-guard.yml', import.meta.url)),
  'utf8',
);

describe('desktop trusted release workflow', () => {
  test('never exposes the update private key to pull-request finalization', () => {
    const finalize = workflow.slice(workflow.indexOf('\n  finalize:'), workflow.indexOf('\n  sign:'));
    assert.ok(finalize.includes('Verify matrix completeness and generate metadata'));
    assert.ok(!finalize.includes('PROPR_DESKTOP_UPDATE_PRIVATE_KEY'));
    assert.equal(
      workflow.match(/secrets\.PROPR_DESKTOP_UPDATE_PRIVATE_KEY/g)?.length,
      1,
      'the private key must appear only in the trusted signing job',
    );
  });

  test('signs only behind the release environment from the immutable desktop tag', () => {
    const signing = workflow.slice(workflow.indexOf('\n  sign:'), workflow.indexOf('\n  publish:'));
    assert.match(signing, /github\.event_name == 'push'/);
    assert.match(signing, /github\.event_name == 'workflow_dispatch'/);
    assert.ok(!signing.includes("github.event_name == 'pull_request'"));
    assert.match(signing, /environment: desktop-release/);
    assert.match(signing, /ref: desktop-v\$\{\{ needs\.version\.outputs\.version \}\}/);
    assert.match(signing, /RELEASE_SHA: \$\{\{ needs\.version\.outputs\.release_sha \}\}/);
    assert.match(signing, /git rev-parse HEAD.*RELEASE_SHA/);
    assert.match(signing, /release-artifacts\.mjs sign/);
    assert.match(signing, /PROPR_DESKTOP_UPDATE_PRIVATE_KEY: \$\{\{ secrets\.PROPR_DESKTOP_UPDATE_PRIVATE_KEY \}\}/);
  });
});
