import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dockerAsync } from '../docker/launcher/orchestrator.mjs';

const eventually = async (operation, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await operation(); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  return operation();
};

test('dockerAsync cancellation terminates the spawned process group before settling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-docker-cancel-'));
  const executable = join(directory, 'docker');
  const descendantPath = join(directory, 'descendant.pid');
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  process.env.PROPR_TEST_DESCENDANT_PATH = descendantPath;
  try {
    await writeFile(executable, '#!/bin/sh\nsleep 30 &\necho "$!" > "$PROPR_TEST_DESCENDANT_PATH"\nwait\n', { mode: 0o700 });
    await chmod(executable, 0o700);
    const controller = new AbortController();
    const operation = dockerAsync(['pull', 'example'], { signal: controller.signal });
    const descendantPid = Number(await eventually(async () => readFile(descendantPath, 'utf8')));
    controller.abort();
    const result = await operation;
    assert.equal(result.error?.code, 'ABORT_ERR');
    await eventually(async () => {
      try {
        const state = (await readFile(`/proc/${descendantPid}/stat`, 'utf8')).split(' ')[2];
        assert.equal(state, 'Z', 'descendant must be terminated (a container PID 1 may leave it as a zombie)');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    });
  } finally {
    process.env.PATH = previousPath;
    delete process.env.PROPR_TEST_DESCENDANT_PATH;
    await rm(directory, { recursive: true, force: true });
  }
});
