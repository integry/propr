import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  requiredNestedPackages,
  stageAppRuntimeDependencies,
} from '../scripts/stage-app-runtime-dependencies.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'docker/Dockerfile.app.prod'), 'utf8');
const repoLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function writePackage(dir, name, main = 'index.js', source = `module.exports = ${JSON.stringify(name)};\n`) {
  writeJson(path.join(dir, 'package.json'), { name, version: '1.0.0', main });
  fs.writeFileSync(path.join(dir, main), source);
}

function fixtureLock() {
  return {
    packages: {
      '': { name: 'root' },
      'node_modules/hoisted': { version: '1.0.0' },
      'packages/core/node_modules/sharp': { version: '0.35.5' },
      'packages/core/node_modules/@img/sharp-linuxmusl-x64': { version: '0.35.5', optional: true },
      'packages/core/node_modules/@img/sharp-darwin-arm64': { version: '0.35.5', optional: true },
      'packages/core/node_modules/sharp/node_modules/inner': { version: '1.0.0' },
      'packages/core/node_modules/linter': { version: '1.0.0', dev: true },
      'packages/api/node_modules/sharp': { version: '0.35.5' },
    },
  };
}

// A pruned builder tree: core and api keep nested sharp, shared has no
// node_modules directory at all, and only core/api are in the root build.
function makeBuilderTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-runtime-deps-'));
  writePackage(path.join(root, 'node_modules/hoisted'), 'hoisted');
  for (const workspace of ['core', 'api']) {
    const nested = path.join(root, 'packages', workspace, 'node_modules');
    writePackage(path.join(nested, 'sharp'), 'sharp', 'index.js', `module.exports = require('hoisted') + ':${workspace}';\n`);
    fs.mkdirSync(path.join(root, 'dist/packages', workspace, 'src'), { recursive: true });
  }
  const coreNested = path.join(root, 'packages/core/node_modules');
  writePackage(path.join(coreNested, '@img/sharp-linuxmusl-x64'), '@img/sharp-linuxmusl-x64');
  writePackage(path.join(coreNested, 'sharp/node_modules/inner'), 'inner');
  fs.mkdirSync(path.join(coreNested, '.bin'));
  fs.symlinkSync('../sharp/index.js', path.join(coreNested, '.bin/sharp'));
  fs.mkdirSync(path.join(root, 'packages/shared/dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/packages/shared/src'), { recursive: true });
  return root;
}

test('stages nested workspace production dependencies for both runtime build locations', (t) => {
  const root = makeBuilderTree();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-runtime-out-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  const staged = stageAppRuntimeDependencies({ root, out, workspaces: ['shared', 'core', 'api'], lock: fixtureLock() });

  assert.deepEqual(staged, [
    { workspace: 'shared', packages: [] },
    { workspace: 'core', packages: ['@img/sharp-linuxmusl-x64', 'sharp'] },
    { workspace: 'api', packages: ['sharp'] },
  ]);
  assert.ok(fs.existsSync(path.join(out, 'packages/core/node_modules/sharp/node_modules/inner/package.json')));
  assert.ok(fs.existsSync(path.join(out, 'packages/core/node_modules/@img/sharp-linuxmusl-x64/package.json')));
  assert.equal(fs.readlinkSync(path.join(out, 'packages/core/node_modules/.bin/sharp')), '../sharp/index.js');
  assert.ok(!fs.existsSync(path.join(out, 'packages/shared')), 'workspace without nested deps contributes nothing');
  assert.ok(!fs.existsSync(path.join(out, 'dist/packages/shared')));

  for (const workspace of ['core', 'api']) {
    const link = path.join(out, 'dist/packages', workspace, 'node_modules');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${workspace} root build links to the workspace tree`);
    assert.equal(fs.readlinkSync(link), path.join('..', '..', '..', 'packages', workspace, 'node_modules'));
  }

  // Assemble the runtime layout the way the Dockerfile does (root node_modules,
  // then the staged overlay) and resolve sharp from every importer location.
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-runtime-app-'));
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), { recursive: true });
  fs.cpSync(out, app, { recursive: true, verbatimSymlinks: true });
  for (const [importer, expected] of [
    ['packages/core/dist/services/attachmentService.js', 'hoisted:core'],
    ['dist/packages/core/src/services/attachmentService.js', 'hoisted:core'],
    ['dist/packages/api/mcp/toolsPreviews.js', 'hoisted:api'],
  ]) {
    assert.equal(createRequire(path.join(app, importer))('sharp'), expected, importer);
  }
});

test('fails when a required nested production dependency is missing', (t) => {
  const root = makeBuilderTree();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-runtime-out-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  fs.rmSync(path.join(root, 'packages/api/node_modules'), { recursive: true });
  assert.throws(
    () => stageAppRuntimeDependencies({ root, out, workspaces: ['api'], lock: fixtureLock() }),
    /packages\/api\/node_modules is missing but package-lock\.json requires: sharp/
  );

  fs.mkdirSync(path.join(root, 'packages/api/node_modules'));
  assert.throws(
    () => stageAppRuntimeDependencies({ root, out, workspaces: ['api'], lock: fixtureLock() }),
    /missing production packages: sharp/
  );
});

test('refuses to stage development or unlocked nested packages', (t) => {
  const root = makeBuilderTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writePackage(path.join(root, 'packages/core/node_modules/linter'), 'linter');
  assert.throws(
    () => stageAppRuntimeDependencies({ root, out: path.join(root, 'out-dev'), workspaces: ['core'], lock: fixtureLock() }),
    /linter is a development dependency/
  );

  fs.rmSync(path.join(root, 'packages/core/node_modules/linter'), { recursive: true });
  writePackage(path.join(root, 'packages/core/node_modules/stray'), 'stray');
  assert.throws(
    () => stageAppRuntimeDependencies({ root, out: path.join(root, 'out-stray'), workspaces: ['core'], lock: fixtureLock() }),
    /stray is not in package-lock\.json/
  );
});

test('app image stages nested dependencies for every shipped workspace', () => {
  const shipped = [...dockerfile.matchAll(/^COPY --from=builder \/build\/packages\/([^/]+)\/package\.json /gm)].map((m) => m[1]);
  assert.deepEqual(shipped.sort(), ['api', 'core', 'local-setup', 'shared']);

  const stageCommand = dockerfile.match(
    /^RUN node scripts\/stage-app-runtime-dependencies\.mjs --root \/build --out \/runtime-deps \\\n\s+([^\n]+)$/m
  );
  assert.ok(stageCommand, 'builder must stage nested workspace dependencies');
  assert.deepEqual(stageCommand[1].trim().split(/\s+/).sort(), shipped.sort());

  const prune = dockerfile.indexOf('RUN npm prune --omit=dev');
  assert.ok(prune > 0 && prune < stageCommand.index, 'staging must run on the pruned tree');

  const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
  const rootDist = runtime.indexOf('COPY --from=builder /build/dist ./dist');
  const overlay = runtime.indexOf('COPY --from=builder /runtime-deps/ ./');
  assert.ok(overlay > rootDist && rootDist > 0, 'nested dependency overlay must be copied after dist');
  assert.doesNotMatch(runtime, /COPY --from=builder \/build\/packages\/[^/]+\/node_modules/);
  assert.doesNotMatch(runtime, /COPY --from=builder \/build\/packages\/[^/]+ \.\/packages\/[^/]+\s*$/m);

  const dockerignore = fs.readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8');
  assert.match(dockerignore, /^\*\*\/node_modules$/m, 'host workspace node_modules must not enter the build');
});

test('current lockfile nested production dependencies are all staged by the app image', () => {
  const staged = dockerfile
    .match(/--out \/runtime-deps \\\n\s+([^\n]+)$/m)[1]
    .trim()
    .split(/\s+/);
  const nestedWorkspaces = new Set(
    Object.entries(repoLock.packages)
      .filter(([key, meta]) => /^packages\/[^/]+\/node_modules\//.test(key) && !meta.dev)
      .map(([key]) => key.split('/')[1])
  );
  for (const workspace of nestedWorkspaces) {
    if (!fs.existsSync(path.join(repoRoot, 'packages', workspace, 'package.json'))) continue;
    if (!dockerfile.includes(`/build/packages/${workspace}/package.json`)) continue;
    assert.ok(staged.includes(workspace), `packages/${workspace} has nested production dependencies and ships in the app image`);
  }
});
