import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { simpleGit } from 'simple-git';
import { commitChanges } from '../src/git/commitOperations.js';

const temporaryDirectories: string[] = [];

async function createRepository(): Promise<{ repository: string; git: ReturnType<typeof simpleGit> }> {
  const repository = await mkdtemp(path.join(tmpdir(), 'propr-commit-operations-'));
  temporaryDirectories.push(repository);
  const git = simpleGit(repository);
  await git.init();
  await git.addConfig('user.name', 'ProPR Test');
  await git.addConfig('user.email', 'test@propr.dev');
  await writeFile(path.join(repository, 'README.md'), 'initial\n');
  await git.add('README.md');
  await git.commit('initial');
  return { repository, git };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

test('excludes visual preview runtime artifacts from commits and reported work output', async () => {
  const { repository, git } = await createRepository();
  await mkdir(path.join(repository, 'src'), { recursive: true });
  await mkdir(path.join(repository, '.propr/previews'), { recursive: true });
  await mkdir(path.join(repository, '.propr/preview-src'), { recursive: true });
  await writeFile(path.join(repository, 'src/feature.ts'), 'export const feature = true;\n');
  await writeFile(path.join(repository, '.propr/previews/feature.png'), 'preview');
  await writeFile(path.join(repository, '.propr/preview-src/feature.html'), '<main>preview</main>');

  const result = await commitChanges(repository, 'feat: add feature', null);

  assert.deepEqual(result?.filesChanged, ['src/feature.ts']);
  assert.equal(
    (await git.raw(['show', '--name-only', '--pretty=format:', 'HEAD'])).trim(),
    'src/feature.ts'
  );
  assert.doesNotMatch(
    await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']),
    /^\.propr\/preview(?:s|-src)\//m
  );
});

test('returns no commit when an execution produces only preview artifacts', async () => {
  const { repository } = await createRepository();
  await mkdir(path.join(repository, '.propr/preview-src'), { recursive: true });
  await writeFile(path.join(repository, '.propr/preview-src/feature.html'), '<main>preview</main>');

  assert.equal(await commitChanges(repository, 'feat: preview only', null), null);
});
