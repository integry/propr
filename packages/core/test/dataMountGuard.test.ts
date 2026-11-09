import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRelativeDatabaseOnDataMount } from '../src/db/dataMountGuard.js';

const cwd = '/usr/src/app';

test('a relative database inside the compose data mount is accepted', () => {
  assertRelativeDatabaseOnDataMount('./data/propr.sqlite', '/usr/src/app/data', cwd);
});

test('a relative database outside a custom PROPR_DATA_DIR mount is refused', () => {
  assert.throws(() => assertRelativeDatabaseOnDataMount('./data/propr.sqlite', '/custom/data', cwd),
    /resolves to \/usr\/src\/app\/data\/propr\.sqlite, outside the mounted data directory \/custom\/data/u);
  assert.throws(() => assertRelativeDatabaseOnDataMount('../data/propr.sqlite', '/usr/src/app/data', cwd));
  assert.throws(() => assertRelativeDatabaseOnDataMount('data', '/usr/src/app/data', cwd), /outside/u);
});

test('absolute, in-memory and URI filenames, or no compose mount, are left alone', () => {
  for (const filename of ['/custom/data/propr.sqlite', '/elsewhere/propr.sqlite', ':memory:', 'file:propr.sqlite?mode=memory']) {
    assertRelativeDatabaseOnDataMount(filename, '/custom/data', cwd);
  }
  assertRelativeDatabaseOnDataMount('./data/propr.sqlite', undefined, cwd);
});
