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
  assert.notEqual(config.agents[2].configPath, agents[2].configPath);
  assert.deepEqual(readdirSync(config.agents[2].configPath), []);
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

 test('Antigravity copies saved onboarding and auth without copying plugins or host settings', () => fixture(root => {
  const source = join(root, 'agy');
  mkdirSync(join(source, 'antigravity-cli/cache'), { recursive: true });
  const files = ['antigravity-cli/antigravity-oauth-token', 'antigravity-cli/cache/onboarding.json'];
  for (const name of files) writeFileSync(join(source, name), name, { mode: 0o600 });
  writeFileSync(join(source, 'antigravity-cli/settings.json'), '{"mcpServers":{"host":{}}}');
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ agents: [{ provider: 'agy', configPath: source }] }));
  prepareAgentTankRuntime(file);
  const home = JSON.parse(readFileSync(file, 'utf8')).agents[0].configPath;
  for (const name of files) {
    assert.equal(readFileSync(join(home, name), 'utf8'), name);
    writeFileSync(join(home, name), 'private update');
    assert.equal(readFileSync(join(source, name), 'utf8'), name);
  }
  assert.equal(existsSync(join(home, 'antigravity-cli/settings.json')), false);
}));

test('Claude keeps account onboarding but excludes project commands and MCP settings', () => fixture(root => {
  const source = join(root, 'claude');
  mkdirSync(source);
  const profile = { hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.295', oauthAccount: { accountUuid: 'test' }, userID: 'test', projects: { '/tmp': { mcpServers: {} } }, hooks: { SessionStart: 'do-not-run' } };
  writeFileSync(join(source, '.claude.json'), JSON.stringify(profile));
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ agents: [{ provider: 'claude', configPath: source }] }));
  prepareAgentTankRuntime(file);
  const home = JSON.parse(readFileSync(file, 'utf8')).agents[0].configPath;
  const copied = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(Object.keys(copied).sort(), ['hasCompletedOnboarding', 'lastOnboardingVersion', 'oauthAccount', 'userID'].sort());
  assert.equal(copied.hasCompletedOnboarding, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).claudeApi, true);
  assert.deepEqual(JSON.parse(readFileSync(join(source, '.claude.json'), 'utf8')), profile);
}));
