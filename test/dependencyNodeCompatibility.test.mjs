import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import semver from 'semver';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const manifest = readJson('../package.json');
const lock = readJson('../package-lock.json');
const minimumNode = semver.minVersion(manifest.engines.node);

test('the root Undici manifest and lockfile select a patched compatible release', () => {
  const range = manifest.dependencies.undici;
  const undici = lock.packages['node_modules/undici'];
  assert.equal(lock.packages[''].dependencies.undici, range);
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
  assert.ok(semver.satisfies(undici.version, range));
  assert.ok(semver.gte(undici.version, '7.30.1'));
  assert.ok(semver.satisfies(minimumNode, undici.engines.node),
    `Undici ${undici.version} must support the declared Node minimum ${minimumNode}`);
});

for (const path of ['../package-lock.json', '../docs/package-lock.json']) {
  test(`${path} Undici entries support the root Node minimum`, () => {
    const entries = Object.entries(readJson(path).packages)
      .filter(([name]) => name.endsWith('/node_modules/undici') || name === 'node_modules/undici');
    assert.ok(entries.length > 0);
    for (const [name, dependency] of entries) {
      assert.ok(semver.satisfies(minimumNode, dependency.engines.node),
        `${name}@${dependency.version} requires Node ${dependency.engines.node}, minimum is ${minimumNode}`);
    }
  });
}
