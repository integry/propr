import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { FIXTURE_REGISTRY } from './helpers/pluginHandlerFixture.js';

/**
 * The restricted-imports rule for `packages/plugins/**` (root eslint.config.js):
 * plugin code imports nothing from ProPR but `@propr/shared`. The fixture
 * handlers are linted as if they were plugin folders of the registry package.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, 'eslint.config.js') });
const lintAsPlugin = async (fixture: string, code = readFileSync(path.join(FIXTURE_REGISTRY, fixture, 'handlers.ts'), 'utf8')) => {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, 'packages', 'plugins', fixture, 'handlers.ts') });
  return result.messages;
};

test('the restricted-imports rule fails a fixture plugin that imports core modules', async () => {
  const messages = await lintAsPlugin('fixture-imports-core');
  assert.deepEqual(messages.map(m => [m.ruleId, m.line, m.severity]), [
    ['no-restricted-imports', 5, 2],
    ['no-restricted-imports', 6, 2],
    ['no-restricted-syntax', 10, 2],
  ], JSON.stringify(messages, null, 2));
  assert.ok(messages.every(m => /only @propr\/shared/.test(m.message)));
});

test('a plugin importing only @propr/shared passes, and every way into ProPR internals is refused', async () => {
  assert.deepEqual(await lintAsPlugin('fixture-handlers'), []);
  const refused = [
    "import { db } from '@propr/core';",
    "import type { PluginStore } from '@propr/core';",
    "import { x } from '@propr/api/routes/pluginRoutes.js';",
    "import { x } from '../../core/src/db/connection.js';",
    "import { x } from '../../api/server.js';",
    "import { x } from '../../shared/src/plugins.js';",
    "import { x } from '../../../src/worker.js';",
    "import { x } from '../../../packages/core/src/index.js';",
    "export { x } from '@propr/core';",
    "const m = await import('@propr/core'); export default m;",
    "const m = await import('../../core/src/index.js'); export default m;",
  ];
  for (const code of refused) {
    const messages = await lintAsPlugin('some-plugin', `${code}\n`);
    assert.ok(messages.some(m => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax'), `${code} was not refused`);
  }
  const allowed = [
    "import { PluginSdkError, type PluginContext } from '@propr/shared';",
    "import { createHash } from 'node:crypto';",
    "import { helper } from './helper.js';",
    "import { officialPlugins } from '../src/index.js';",
  ];
  for (const code of allowed) assert.deepEqual(await lintAsPlugin('some-plugin', `${code}\nexport { };\n`), [], code);
});
