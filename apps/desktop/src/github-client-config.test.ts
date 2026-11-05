import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'vite';
import { resolveGithubClientId, validateGithubClientId } from './github-client-config';

test('packaged configuration ignores launch environment; dev uses environment', () => {
  assert.equal(resolveGithubClientId(true, 'fixture-public-client', 'other-client'), 'fixture-public-client');
  assert.equal(resolveGithubClientId(false, 'built-client', 'dev-client'), 'dev-client');
  for (const value of [undefined, '', 'bad\nvalue']) assert.throws(() => validateGithubClientId(value));
  assert.throws(() => resolveGithubClientId(true, undefined, 'dev-client'));
});

test('real Vite build requires configuration and embeds the public input (configuration proof only)', async () => {
  const previous = process.env.PROPR_DESKTOP_GITHUB_CLIENT_ID;
  try {
    delete process.env.PROPR_DESKTOP_GITHUB_CLIENT_ID;
    const options = {
      configFile: new URL('../vite.main.config.ts', import.meta.url).pathname,
      logLevel: 'silent' as const,
      plugins: [{ name: 'configuration-inspection', resolveId: (id: string) => id === 'inspection' ? id : null,
        load: (id: string) => id === 'inspection' ? 'export const client = __PROPR_DESKTOP_GITHUB_CLIENT_ID__;' : null }],
      build: { write: false, rollupOptions: { input: 'inspection', preserveEntrySignatures: 'strict' as const } },
    };
    await assert.rejects(build(options), /PROPR_DESKTOP_GITHUB_CLIENT_ID/);
    process.env.PROPR_DESKTOP_GITHUB_CLIENT_ID = 'fixture-public-client';
    const result = await build(options);
    const outputs = Array.isArray(result) ? result : [result];
    assert.ok(outputs.some(output => 'output' in output && output.output.some(chunk => chunk.type === 'chunk' && chunk.code.includes('fixture-public-client'))));
  } finally {
    if (previous === undefined) delete process.env.PROPR_DESKTOP_GITHUB_CLIENT_ID;
    else process.env.PROPR_DESKTOP_GITHUB_CLIENT_ID = previous;
  }
});
