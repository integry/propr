import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  FULL_TEXT_NOTICES,
  pinnedProductionDependencies,
  validateNoticeText,
} from '../scripts/validate-third-party-notices.mjs';

const committedNotice = readFileSync('THIRD_PARTY_LICENSES.md', 'utf8');
const workflow = readFileSync('.github/workflows/preview-runtime-images.yml', 'utf8');
const dependencies = pinnedProductionDependencies();
const fixtures = [];

afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

// A clean checkout: only tracked inputs of the generator, no node_modules.
const cleanCheckout = () => {
  const root = mkdtempSync(join(tmpdir(), 'propr-notices-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'));
  for (const file of ['package.json', 'package-lock.json', 'THIRD_PARTY_LICENSES.md',
    'scripts/generate-notices.sh', 'scripts/validate-third-party-notices.mjs']) {
    copyFileSync(file, join(root, file));
  }
  return root;
};

// Stands in for `npx license-checker`, printing what it reports for the tree.
const fakeNpx = (root, rows) => {
  const bin = join(root, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(root, 'license-rows.json'), JSON.stringify(rows));
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node
const rows = require(${JSON.stringify(join(root, 'license-rows.json'))});
if (process.argv.includes('--summary')) {
  const counts = {};
  for (const [, license] of rows) counts[license] = (counts[license] ?? 0) + 1;
  for (const [license, count] of Object.entries(counts)) console.log('├─ ' + license + ': ' + count);
} else {
  console.log('"module name","license","repository"');
  for (const [id, license] of rows) console.log(JSON.stringify(id) + ',' + JSON.stringify(license) + ',""');
}
`);
  chmodSync(join(bin, 'npx'), 0o755);
  return bin;
};

const installPinnedTree = (root, overrides = {}) => {
  for (const { name, version } of dependencies) {
    const directory = join(root, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: overrides[name] ?? version }));
  }
  for (const { name, license } of FULL_TEXT_NOTICES) {
    writeFileSync(join(root, 'node_modules', name, license), `Full license text for ${name}.\n`);
  }
};

const completeRows = () => [
  ['propr@0.9.0', 'Apache-2.0'],
  ...dependencies.map(({ name, version }) => [`${name}@${version}`, 'MIT']),
  ['transitive-a@1.0.0', 'MIT'],
  ['transitive-b@2.0.0', 'ISC'],
];

const generate = (root, bin) => spawnSync('bash', [join(root, 'scripts/generate-notices.sh')], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter), TMPDIR: root },
});

// The degraded artifact observed from a real clean-checkout run: the bundled
// Anthropic sections vanish and the inventory collapses to the root package.
const degradedNotice = () => committedNotice
  .replace(/^## @anthropic-ai\/claude-code@[\s\S]*?(?=^## @openai\/codex)/m, '')
  .replace(/(## All Propr npm production dependencies[\s\S]*?```\n)[\s\S]*$/,
    '$1└─ UNLICENSED: 1\n```\n\n### Full per-package list\n\n```\n"module name","license","repository"\n"propr@0.9.0","UNLICENSED",""\n```\n');

describe('third-party notice generation from a clean checkout', () => {
  test('refuses to generate without installed dependencies and keeps the existing notice', () => {
    const root = cleanCheckout();
    const result = generate(root, fakeNpx(root, [['propr@0.9.0', 'UNLICENSED']]));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /incomplete dependency tree/);
    assert.match(result.stderr, /@anthropic-ai\/claude-code@\d+\.\d+\.\d+ is not installed/);
    assert.match(result.stderr, /@anthropic-ai\/sdk license text LICENSE is missing/);
    assert.match(result.stderr, /npm ci/);
    assert.equal(readFileSync(join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8'), committedNotice);
  });

  test('refuses an installed tree that drifts from package-lock pins', () => {
    const root = cleanCheckout();
    installPinnedTree(root, { '@anthropic-ai/claude-code': '0.0.1' });
    const result = generate(root, fakeNpx(root, completeRows()));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /@anthropic-ai\/claude-code is installed at 0\.0\.1, but package-lock\.json pins/);
    assert.equal(readFileSync(join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8'), committedNotice);
  });

  test('refuses a collapsed license inventory without overwriting the notice', () => {
    const root = cleanCheckout();
    installPinnedTree(root);
    const result = generate(root, fakeNpx(root, [['propr@0.9.0', 'UNLICENSED']]));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not be baked into an image/);
    assert.match(result.stderr, /inventory is missing @anthropic-ai\/claude-code@/);
    assert.equal(readFileSync(join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8'), committedNotice);
  });

  test('writes complete bundled sections and inventory from the pinned tree', () => {
    const root = cleanCheckout();
    installPinnedTree(root);
    const result = generate(root, fakeNpx(root, completeRows()));
    assert.equal(result.status, 0, result.stderr);
    const notice = readFileSync(join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8');
    for (const { name } of FULL_TEXT_NOTICES) {
      const { version } = dependencies.find(dependency => dependency.name === name);
      assert.match(notice, new RegExp(`## ${name.replace('/', '\\/')}@${version.replaceAll('.', '\\.')}\\n\\n\`\`\`\\nFull license text for`));
    }
    assert.match(notice, /"transitive-b@2\.0\.0","ISC",""/);
    assert.deepEqual(validateNoticeText(notice), { packages: completeRows().length });
  });
});

describe('third-party notice validation', () => {
  test('rejects the degraded clean-checkout notice shape', () => {
    assert.throws(() => validateNoticeText(degradedNotice()), error => {
      for (const { name } of FULL_TEXT_NOTICES) {
        assert.match(error.message, new RegExp(`missing full license text section for ${name.replace('/', '\\/')}@`));
      }
      assert.match(error.message, /inventory is missing @anthropic-ai\/sdk@/);
      assert.match(error.message, /inventory lists only 1 packages/);
      return true;
    });
  });

  test('rejects an empty bundled license section and a failed inventory', () => {
    const text = committedNotice
      .replace(/(## @anthropic-ai\/sdk@[^\n]+\n\n```\n)[\s\S]*?```/, '$1```')
      .replace(/^"[\s\S]*?(?=```\n*$)/m, '(full list generation failed)\n');
    assert.throws(() => validateNoticeText(text), /section for @anthropic-ai\/sdk@[\s\S]*inventory failed to generate/);
  });
});

describe('preview image builds install the pinned tree before baking notices', () => {
  const job = (name, next) => workflow.slice(workflow.indexOf(`\n  ${name}:\n`), workflow.indexOf(`\n  ${next}:\n`));

  for (const [name, next, only] of [['build-native', 'assemble', 'app,ui'], ['build-agent', 'assemble-agent', 'agent']]) {
    test(`${name} runs a script-free npm ci before build-images.sh`, () => {
      const build = job(name, next);
      const install = build.indexOf('npm ci --ignore-scripts');
      assert.ok(install > 0, `${name} must install root dependencies`);
      assert.ok(install < build.indexOf(`build-images.sh --sha-only --only ${only}`));
      assert.ok(build.indexOf('persist-credentials: false') < install);
      assert.doesNotMatch(build, /secrets\.|environment:|docker login|NODE_AUTH_TOKEN/);
    });
  }
});
