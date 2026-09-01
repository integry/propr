import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolvePackagedSetupResources } from './desktop-host';

const createResources = async (): Promise<string> => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'propr-desktop-resources-'));
  await mkdir(join(root, 'orchestrator'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'orchestrator', 'orchestrator.mjs'), 'export {};\n');
  await writeFile(join(root, 'assets', 'env.example.txt'), 'PROPR_DATA_DIR=data\n');
  return root;
};

describe('packaged desktop setup resources', () => {
  it('returns canonical regular resources beneath resourcesPath', async () => {
    const root = await createResources();
    try {
      const resources = await resolvePackagedSetupResources(root);
      assert.equal(
        await realpath(resources.orchestratorPath),
        await realpath(join(root, 'orchestrator', 'orchestrator.mjs')),
      );
      assert.equal(
        await realpath(resources.stackTemplatePath),
        await realpath(join(root, 'assets', 'env.example.txt')),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects linked resource ancestors and linked files', async () => {
    const root = await createResources();
    const outside = await mkdtemp(join(realpathSync(tmpdir()), 'propr-desktop-resource-target-'));
    try {
      await rm(join(root, 'orchestrator'), { recursive: true });
      await symlink(outside, join(root, 'orchestrator'));
      await writeFile(join(outside, 'orchestrator.mjs'), 'export {};\n');
      await assert.rejects(resolvePackagedSetupResources(root), /symbolic links/);

      await rm(join(root, 'orchestrator'));
      await mkdir(join(root, 'orchestrator'));
      await symlink(join(outside, 'orchestrator.mjs'), join(root, 'orchestrator', 'orchestrator.mjs'));
      await assert.rejects(resolvePackagedSetupResources(root), /symbolic links/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
