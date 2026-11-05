import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getWorktreeChanges } from '../src/services/worktreeMonitorService.js';

for (const tracking of [true, false]) {
  test(`committing preserves file patches and counts ${tracking ? 'against the tracking branch' : 'without an upstream'}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-committed-changes-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString();
    const commit = () => git('-c', 'user.name=Acceptance Test', '-c', 'user.email=acceptance@example.invalid', 'commit', '-m', 'fixture');
    git('init', '-b', 'main');
    await writeFile(join(directory, 'modified.txt'), 'old\n');
    await writeFile(join(directory, 'deleted.txt'), 'remove\n');
    git('add', '.');
    commit();
    git('switch', '-c', 'task');
    if (tracking) git('branch', '--set-upstream-to=main');
    await mkdir(join(directory, 'docs'));
    await writeFile(join(directory, 'docs/acceptance.md'), '# Acceptance\n\n- one\n- two\n- three\n');
    await writeFile(join(directory, 'modified.txt'), 'new\nsecond\n');
    await rm(join(directory, 'deleted.txt'));
    git('add', '.');

    const expected = [
      { path: 'deleted.txt', status: 'deleted', linesAdded: 0, linesRemoved: 1 },
      { path: 'docs/acceptance.md', status: 'added', linesAdded: 5, linesRemoved: 0 },
      { path: 'modified.txt', status: 'modified', linesAdded: 2, linesRemoved: 1 },
    ];
    const checkChanges = async () => {
      const changes = await getWorktreeChanges(directory);
      assert.deepEqual(changes.map(({ diff: _diff, ...file }) => file).sort((a, b) => a.path.localeCompare(b.path)), expected);
      assert.match(changes.find(file => file.path === 'docs/acceptance.md')!.diff, /\+# Acceptance/);
    };
    await checkChanges();
    commit();
    await checkChanges();
  });
}

test('the final scan preserves all task commits after pushing to the task upstream', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-pushed-changes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString();
  const commit = () => git('-c', 'user.name=Acceptance Test', '-c', 'user.email=acceptance@example.invalid', 'commit', '-m', 'fixture');
  git('init', '-b', 'main');
  await writeFile(join(directory, 'existing.txt'), 'original\n');
  git('add', '.');
  commit();
  const base = git('rev-parse', 'HEAD').trim();
  // A local bare remote reproduces push -u without network access.
  const remote = await mkdtemp(join(tmpdir(), 'propr-pushed-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  git('switch', '-c', 'task');
  git('push', '-u', 'origin', 'task');
  await mkdir(join(directory, 'docs'));
  const path = 'docs/desktop-final-preview-20261014.md';
  await writeFile(join(directory, path), '# Desktop preview\n- Completed task\n- Commit pushed\n- PR opened\n');
  git('add', 'docs');
  const liveChanges = await getWorktreeChanges(directory);
  assert.equal(liveChanges[0].status, 'added');
  assert.equal(liveChanges[0].linesAdded, 4);
  commit();
  await writeFile(join(directory, 'existing.txt'), 'updated\n');
  git('add', 'existing.txt');
  commit();
  git('push', 'origin', 'task');

  const changes = await getWorktreeChanges(directory, base);
  const added = changes.find(file => file.path === path)!;
  assert.deepEqual({ ...added, diff: added.diff.trim() }, liveChanges[0]);
  assert.match(added.diff, /new file mode/);
  assert.match(added.diff, /\+# Desktop preview\n\+- Completed task\n\+- Commit pushed\n\+- PR opened/);
  assert.equal(added.linesRemoved, 0);
  assert.equal(changes.length, 2);
  await writeFile(join(directory, 'untracked.log'), 'leftover agent output\n');
  assert.deepEqual(await getWorktreeChanges(directory, base), changes);

  // Ordinary live scans still compare uncommitted edits with HEAD.
  await writeFile(join(directory, 'existing.txt'), 'live edit\n');
  const live = await getWorktreeChanges(directory);
  assert.equal(live.length, 1);
  assert.equal(live[0].status, 'modified');
  assert.equal(live[0].linesAdded, 1);
  assert.equal(live[0].linesRemoved, 1);
  assert.match(live[0].diff, /-updated\n\+live edit/);
  const final = await getWorktreeChanges(directory, base);
  assert.equal(final.length, 2);
  assert.match(final.find(file => file.path === 'existing.txt')!.diff, /-original\n\+live edit/);
});
