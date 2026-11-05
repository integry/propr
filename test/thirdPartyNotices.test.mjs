import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const generate = (root, bin, env = {}) => spawnSync('bash', [join(root, 'scripts/generate-notices.sh')], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...withoutDateOverrides(process.env),
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
    TMPDIR: root,
    ...env,
  },
});

const withoutDateOverrides = ({ NOTICES_DATE, SOURCE_DATE_EPOCH, ...env }) => env;

// Stands in for the system clock: `date` reports the given day.
const fakeClock = (bin, day) => {
  writeFileSync(join(bin, 'date'), `#!/bin/sh\necho ${day}\n`);
  chmodSync(join(bin, 'date'), 0o755);
};

const generatedDate = text => text.match(/^Generated: (.*)$/m)?.[1];
// The notice's share of the agent bundle content hash (build-images.sh, versionService.ts).
const contentHash = text => createHash('sha256').update(text).digest('hex').slice(0, 6);

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

describe('third-party notice Generated date is deterministic per commit', () => {
  const git = (root, args, env = {}) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  }).trim();

  const committedCheckout = authorDate => {
    const root = cleanCheckout();
    installPinnedTree(root);
    git(root, ['init', '-q']);
    git(root, ['add', 'package.json', 'package-lock.json', 'THIRD_PARTY_LICENSES.md', 'scripts']);
    git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'lock'], {
      GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: '2031-05-05T12:00:00Z',
    });
    return root;
  };

  const generateOn = (root, bin, day, env = {}) => {
    fakeClock(bin, day);
    const result = generate(root, bin, { TZ: 'Pacific/Kiritimati', ...env });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8');
  };

  test('regenerating the same commit on different days yields identical bytes and content hash', () => {
    const root = committedCheckout('2030-03-04T23:30:00-05:00');
    const bin = fakeNpx(root, completeRows());
    const first = generateOn(root, bin, '2031-01-01');
    const second = generateOn(root, bin, '2031-06-15');
    assert.equal(generatedDate(first), '2030-03-05');
    assert.equal(second, first);
    assert.equal(contentHash(second), contentHash(first));
  });

  test('without git history the existing notice date is kept', () => {
    const root = cleanCheckout();
    installPinnedTree(root);
    const bin = fakeNpx(root, completeRows());
    assert.equal(generatedDate(generateOn(root, bin, '2031-01-01')), generatedDate(committedNotice));
    assert.equal(generatedDate(generateOn(root, bin, '2031-06-15')), generatedDate(committedNotice));
  });

  test('an uncommitted package-lock.json change is dated today, the day its commit is authored', () => {
    const root = committedCheckout('2030-03-04T12:00:00Z');
    writeFileSync(join(root, 'package-lock.json'), `${readFileSync(join(root, 'package-lock.json'), 'utf8')}\n`);
    assert.equal(generatedDate(generateOn(root, fakeNpx(root, completeRows()), '2031-01-01')), '2031-01-01');
  });

  test('NOTICES_DATE and SOURCE_DATE_EPOCH override the commit date', () => {
    const root = committedCheckout('2030-03-04T12:00:00Z');
    const bin = fakeNpx(root, completeRows());
    assert.equal(generatedDate(generateOn(root, bin, '2031-01-01', { SOURCE_DATE_EPOCH: '1700000000' })), '2023-11-14');
    assert.equal(generatedDate(generateOn(root, bin, '2031-01-01', {
      SOURCE_DATE_EPOCH: '1700000000', NOTICES_DATE: '2029-02-03',
    })), '2029-02-03');
    fakeClock(bin, '2031-01-01');
    const invalid = generate(root, bin, { NOTICES_DATE: 'today' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /NOTICES_DATE must be YYYY-MM-DD/);
  });

  test('the committed notice carries the date a build of this checkout derives', context => {
    const history = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' });
    if (history.status !== 0 || history.stdout.trim() !== 'false') {
      context.skip('needs a git checkout with full history');
      return;
    }
    if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'package-lock.json']).status !== 0) {
      context.skip('package-lock.json has uncommitted changes');
      return;
    }
    const epoch = Number(git('.', ['log', '-1', '--format=%at', '--', 'package-lock.json']));
    assert.equal(generatedDate(committedNotice), new Date(epoch * 1000).toISOString().slice(0, 10),
      'THIRD_PARTY_LICENSES.md is stale for this commit; run scripts/generate-notices.sh');
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
