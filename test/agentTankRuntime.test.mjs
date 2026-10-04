import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareAgentTankRuntime } from '../scripts/agent-tank-runtime.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'tank-runtime-test-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('provider writes stay private while only authentication is copied from read-only homes', () => fixture(root => {
  const agents = ['claude', 'codex', 'agy'].map(provider => {
    const configPath = join(root, provider);
    mkdirSync(configPath);
    writeFileSync(join(configPath, 'config.toml'), 'host MCP and plugin configuration');
    return { provider, id: provider, configPath };
  });
  const claudeAuth = join(agents[0].configPath, '.credentials.json');
  const codexAuth = join(agents[1].configPath, 'auth.json');
  writeFileSync(claudeAuth, '{"fake":"claude"}');
  writeFileSync(codexAuth, '{"fake":"codex"}');
  chmodSync(claudeAuth, 0o400);
  chmodSync(codexAuth, 0o400);
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ agents, dockerAccess: false }));
  const runtime = prepareAgentTankRuntime(file);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.claudeApi, true);
  assert.equal(config.dockerAccess, false);
  assert.deepEqual(config.agents[2], agents[2]);
  assert.equal(statSync(runtime).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const [index, filename] of ['.credentials.json', 'auth.json'].entries()) {
    const home = config.agents[index].configPath;
    assert.notEqual(home, agents[index].configPath);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(home), [filename]);
    assert.equal(statSync(join(home, filename)).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(home, filename), 'utf8'), readFileSync(join(agents[index].configPath, filename), 'utf8'));
    writeFileSync(join(home, filename), 'refreshed');
    writeFileSync(join(home, 'state.sqlite'), 'private CLI state');
    assert.notEqual(readFileSync(join(agents[index].configPath, filename), 'utf8'), 'refreshed');
    assert.equal(existsSync(join(agents[index].configPath, 'state.sqlite')), false);
  }
}));

test('missing credentials stay missing instead of falling back to another host account', () => fixture(root => {
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ agents: [{ provider: 'codex', id: 'custom', configPath: join(root, 'missing') }] }));
  prepareAgentTankRuntime(file);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.agents[0].id, 'custom');
  assert.deepEqual(readdirSync(config.agents[0].configPath), []);
}));

test('failed preparation cleans private copies and does not disclose configuration', () => fixture(root => {
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ agents: [{ provider: 'codex', configPath: { secret: 'do-not-log' } }] }));
  const result = spawnSync(process.execPath, ['scripts/agent-tank-runtime.mjs', file], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'Unable to prepare isolated Agent Tank runtime');
  assert.equal(result.stdout, '');
  assert.deepEqual(readdirSync(root), ['config.json']);
}));
