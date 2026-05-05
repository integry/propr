import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { resolveJobModulePath } from '../packages/api/services/ultrafixInit.ts';

test('resolveJobModulePath finds repo-root TypeScript jobs in dev layout', async () => {
    const resolved = await resolveJobModulePath('ultrafixBootstrap.js');
    assert.strictEqual(
        resolved,
        path.resolve(process.cwd(), 'src/jobs/ultrafixBootstrap.ts'),
    );
});
