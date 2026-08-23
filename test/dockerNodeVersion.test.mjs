import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const backendDockerfiles = [
  '../Dockerfile',
  '../Dockerfile.node',
  '../packages/api/Dockerfile.prod',
  '../docker/Dockerfile.app.prod',
];

test('backend Dockerfiles satisfy the declared Node 22 runtime baseline', () => {
  for (const relativePath of backendDockerfiles) {
    const dockerfileUrl = new URL(relativePath, import.meta.url);
    const dockerfile = readFileSync(dockerfileUrl, 'utf8');
    const nodeStages = [...dockerfile.matchAll(/^FROM node:(\d+)(?:[-@]|\s|$)/gm)];

    assert.ok(nodeStages.length > 0, `${relativePath} must contain a Node base image`);
    for (const stage of nodeStages) {
      assert.equal(stage[1], '22', `${relativePath} must use Node 22 for every stage`);
    }
  }
});
