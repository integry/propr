import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiled-distribution smoke for the admin recovery routes. The source-level
// smoke in followupHandoffRoutes.test.ts runs through the tsx test runtime,
// which resolves `.ts` sources and tsconfig paths; this one emits the route
// module and the recovery job the way the root build does, then loads them in
// a plain Node process. That proves the packaged relative import from
// dist/packages/api/routes to dist/src/jobs resolves, and that the emitted
// recovery graph runs against the shipped dependency closure (@propr/core
// through node_modules, as in the production image) rather than sources.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('the compiled admin routes load the compiled recovery module under plain Node', () => {
  // Emitted inside the repository so bare specifiers resolve through its
  // node_modules exactly as they do for the root dist/ output.
  const cacheRoot = path.join(repoRoot, 'node_modules', '.cache');
  mkdirSync(cacheRoot, { recursive: true });
  const workDir = mkdtempSync(path.join(cacheRoot, 'followup-handoff-dist-'));
  try {
    const outDir = path.join(workDir, 'dist');
    writeFileSync(path.join(workDir, 'tsconfig.json'), JSON.stringify({
      extends: path.join(repoRoot, 'tsconfig.json'),
      // Emission only: type checking is the separate typecheck gate.
      compilerOptions: { outDir, rootDir: repoRoot, noCheck: true, declaration: false },
      files: [
        path.join(repoRoot, 'packages/api/routes/followupHandoffRoutes.ts'),
        path.join(repoRoot, 'src/jobs/followupHandoffRecovery.ts'),
      ],
      include: [],
    }));
    const build = spawnSync(process.execPath, [path.join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', path.join(workDir, 'tsconfig.json')], {
      cwd: repoRoot, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(build.status, 0, `tsc emit failed:\n${build.stdout}\n${build.stderr}`);
    writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));

    const runtimeDir = path.join(workDir, 'runtime');
    mkdirSync(runtimeDir);
    const script = `
      const { createDefaultFollowupHandoffDeps } = await import(${JSON.stringify(path.join(outDir, 'packages/api/routes/followupHandoffRoutes.js'))});
      const { default: knex } = await import(${JSON.stringify(path.join(repoRoot, 'node_modules/knex/knex.js'))});
      const { up } = await import(${JSON.stringify(path.join(repoRoot, 'packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js'))});
      const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
      try {
        await up(database);
        const statuses = await createDefaultFollowupHandoffDeps().inspectFollowupHandoffs({ store: { database } });
        process.stdout.write('RESULT ' + JSON.stringify(statuses) + '\\n');
      } finally {
        await database.destroy();
      }
      process.exit(0);
    `;
    // No inherited loader (tsx registers through NODE_OPTIONS): plain Node only.
    const env = { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '' };
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: runtimeDir, env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(run.status, 0, `compiled recovery routes failed under plain Node:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /^RESULT \[\]$/m, 'the compiled module answers with the injected empty store');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
