import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { getManagedAgentConfigPath } from '@propr/shared';
import { resolveConfigPath } from '../packages/core/src/config/agentConfigPaths.ts';

/**
 * The Fly smoke installs each non-Claude agent's credential file over `fly ssh console`, whose
 * session lacks the app container's configured environment (PROPR_MANAGED_CREDENTIALS_DIR).
 * These run the scripts exactly as the workflow assembles them, from the repository root as the
 * app container runs them from /usr/src/app, and check the file lands where the saved agent's
 * configPath resolves in the app.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = parse(readFileSync(path.join(ROOT, '.github/workflows/fly-e2e.yml'), 'utf8'));
const STEP: string = Object.values(WORKFLOW.jobs as Record<string, { steps?: { name?: string; run?: string }[] }>)
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.name === 'Configure the fixture agent and runtime package before idle shutdown')?.run ?? '';
const scratch = mkdtempSync(path.join(tmpdir(), 'fly-e2e-credential-install-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const CREDENTIALS = {
  opencode: { key: 'OPENCODE_CONFIG_B64', file: 'opencode.json', content: '{"model":"opencode/big-pickle"}\n' },
  vibe: { key: 'VIBE_ENV_B64', file: '.env', content: 'MISTRAL_API_KEY=fixture-mistral-key-0123456789\n' },
} as const;
type Agent = keyof typeof CREDENTIALS;

/** The workflow's `install=$(...)` assignment, evaluated by bash for `agent`: the decoded script. */
function installScript(agent: Agent): string {
  const lines = STEP.split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith('install=$('));
  assert.ok(start >= 0, 'the workflow assembles the credential install');
  const end = lines.findIndex((line, index) => index >= start && line.trimEnd().endsWith('| base64 -w0)'));
  const assignment = lines.slice(start, end + 1).join('\n');
  const encoded = execFileSync('bash', ['-euc', `${assignment}\nprintf %s "$install"`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, AGENT: agent, AGENT_CREDENTIAL_KEY: CREDENTIALS[agent].key, AGENT_CREDENTIAL_FILE: CREDENTIALS[agent].file },
  });
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/** The agent save's configPath, from the same store helper the workflow prepends to it. */
function savedConfigPath(agent: Agent, env: NodeJS.ProcessEnv): string {
  assert.match(STEP, /cat \.github\/fly-e2e\/agent-credential-store\.mjs\n/, 'the agent save is assembled with the store helper');
  assert.match(STEP, /configPath: store\.configPath/, 'the agent save uses the helper\'s configPath');
  const helper = readFileSync(path.join(ROOT, '.github/fly-e2e/agent-credential-store.mjs'), 'utf8');
  return runModule(`${helper}\nconsole.log((await agentCredentialStore('${agent}')).configPath);`, env).stdout.trim();
}

/** Runs `source` the way the SSH command does: `node --input-type=module` reading stdin, in the app directory. */
function runModule(source: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, ['--input-type=module'], { cwd: ROOT, input: source, encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** An SSH session's environment: no app configuration unless given; the app process environment from `appEnviron`. */
function sessionEnv(name: string, session: Record<string, string>, appEnviron: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environFile = path.join(scratch, `${name}.environ`);
  writeFileSync(environFile, Object.entries(appEnviron).map(([key, value]) => `${key}=${value}\0`).join(''));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(scratch, `${name}-home`), PROPR_E2E_APP_ENVIRON_FILE: environFile, ...session };
  assert.equal(env.PROPR_MANAGED_CREDENTIALS_DIR, undefined);
  return env;
}

const encoded = (agent: Agent) => Buffer.from(CREDENTIALS[agent].content).toString('base64');

for (const agent of ['opencode', 'vibe'] as const) {
  test(`${agent}: installs with PROPR_MANAGED_CREDENTIALS_DIR unset, under DATA_DIR/agent-credentials, where the saved configPath resolves`, () => {
    const dataDir = path.join(scratch, `${agent}-data`);
    const env = sessionEnv(agent, { DATA_DIR: dataDir, [CREDENTIALS[agent].key]: encoded(agent) });
    const result = runModule(installScript(agent), env);
    assert.equal(result.status, 0, result.stderr);

    const configPath = savedConfigPath(agent, env);
    if (agent === 'opencode') assert.equal(configPath, getManagedAgentConfigPath('opencode', 'opencode'));
    // The app on Fly: the deploy sets PROPR_MANAGED_CREDENTIALS_DIR to $DATA_DIR/agent-credentials.
    const store = resolveConfigPath(configPath, { HOME: '/home/node', PROPR_CONTAINERIZED: '1', PROPR_MANAGED_CREDENTIALS_DIR: path.join(dataDir, 'agent-credentials') });
    assert.ok(store.startsWith(path.join(dataDir, 'agent-credentials') + path.sep), store);
    const installed = path.join(store, CREDENTIALS[agent].file);
    assert.equal(readFileSync(installed, 'utf8'), CREDENTIALS[agent].content);
    assert.equal(result.stdout.trim(), String(Buffer.byteLength(CREDENTIALS[agent].content)));
    assert.equal(statSync(installed).mode & 0o777, 0o600);
    assert.equal(statSync(store).mode & 0o777, 0o700);
  });
}

test('reads the managed credential directory and the key from the app process environment when the session has neither', () => {
  const managed = path.join(scratch, 'app-environ-managed');
  const env = sessionEnv('app-environ', {}, { DATA_DIR: path.join(scratch, 'unused'), PROPR_MANAGED_CREDENTIALS_DIR: managed, OPENCODE_CONFIG_B64: encoded('opencode') });
  const result = runModule(installScript('opencode'), env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(managed, 'opencode/.config/opencode/opencode.json'), 'utf8'), CREDENTIALS.opencode.content);
  assert.equal(existsSync(path.join(scratch, 'unused')), false);
});

test('fails naming PROPR_MANAGED_CREDENTIALS_DIR and DATA_DIR when neither is set anywhere', () => {
  const env = sessionEnv('unset', { OPENCODE_CONFIG_B64: encoded('opencode') });
  const result = runModule(installScript('opencode'), env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROPR_MANAGED_CREDENTIALS_DIR and DATA_DIR are both unset/);
  assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE/);
});

test('fails naming the credential key when it is unset', () => {
  const env = sessionEnv('no-key', { DATA_DIR: path.join(scratch, 'no-key-data') });
  const result = runModule(installScript('vibe'), env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VIBE_ENV_B64 is unset/);
  assert.equal(existsSync(path.join(scratch, 'no-key-data')), false);
});
