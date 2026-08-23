import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('gh wrapper delegates to the real binary instead of resolving itself through PATH', () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'propr-gh-wrapper-'));
  const realGh = path.join(fixtureDir, 'real-gh');
  const wrappedGh = path.join(fixtureDir, 'gh');
  const wrapper = path.resolve('scripts/gh-wrapper.sh');

  writeFileSync(realGh, '#!/bin/sh\nprintf "gh version fixture\\n"\n');
  chmodSync(realGh, 0o755);
  symlinkSync(wrapper, wrappedGh);

  for (const args of [[], ['--version']]) {
    const result = spawnSync(wrappedGh, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixtureDir}:${process.env.PATH ?? ''}`,
        PROPR_GH_REAL_BIN: realGh,
      },
      timeout: 2_000,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'gh version fixture\n');
  }
});
