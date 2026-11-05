import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('API starts from a symlink and an importing supervisor without relying on argv identity', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const link = path.join(root, 'api.ts'); await fs.symlink(path.resolve('packages/api/server.ts'), link);
  const wrapper = path.join(root, 'supervisor.mjs');
  await fs.writeFile(wrapper, `await import(${JSON.stringify(pathToFileURL(link).href)});`);
  for (const [index, entry] of [link, wrapper].entries()) {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', PROPR_DEMO_MODE: 'true', MCP_ENABLED: 'false', FRONTEND_URL: 'http://localhost:3000', DASHBOARD_API_PORT: '0', DATA_DIR: path.join(root, String(index)), DB_FILENAME: path.join(root, String(index), 'test.sqlite'), PROPR_API_DISABLE_AUTOSTART: '', SESSION_SECRET: 'synthetic-startup-session-secret-long-enough-123456789' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output.slice(-2000)}`)), 20_000);
        const observe = (chunk: Buffer) => { output += chunk; if (output.includes('Dashboard API server running at')) { clearTimeout(timer); resolve(); } };
        child.stdout.on('data', observe); child.stderr.on('data', observe);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}: ${output.slice(-2000)}`)); });
      });
      assert.match(output, /Demo mode enabled/);
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('close', () => resolve())); }
    }
  }
});
