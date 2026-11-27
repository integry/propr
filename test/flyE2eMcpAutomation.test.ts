import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, RequestHandler, Response } from 'express';

/**
 * The Fly smoke workflow's MCP mode creates and starts a `propr_mcp`
 * automation through the REST API. This pushes exactly that payload through
 * the real route handlers, the real runtime validator and the real config
 * store, configured the way the fixture configures its instance: Sprites,
 * PROPR_SPRITES_MCP_TRANSPORT=forward and no public MCP URL. Only GitHub
 * repository access and the job queue are stood in for.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = 'acme/fixture';
const OWNER = 'fixture-owner';
const dataDir = await mkdtemp(path.join(tmpdir(), 'fly-e2e-mcp-automation-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.DB_FILENAME = path.join(dataDir, 'core.sqlite');
// The fixture deploy: env-monitored repository, Sprites runtime, forced forward, no public URL.
process.env.GITHUB_REPOS_TO_MONITOR = REPOSITORY;
process.env.PROPR_AGENT_RUNTIME = 'sprites';
process.env.PROPR_SPRITES_MCP_TRANSPORT = 'forward';
process.env.PROPR_INTERNAL_API_URL = 'http://127.0.0.1:4000';
for (const name of ['API_PUBLIC_URL', 'PROPR_AGENT_MCP_URL', 'PROPR_SPRITES_MCP_URL', 'PROPR_SPRITES_MCP_FORWARD', 'CONFIG_REPO']) delete process.env[name];

const core = await import('@propr/core');
const { getManagedAgentConfigPath } = await import('@propr/shared');
const { createAutomationDefinitionRoutes } = await import('../packages/api/routes/automationDefinitionRoutes.ts');
const { requestAgentRunMcpGrant } = await import('../src/jobs/agentRuns/mcpGrantClient.ts');

after(async () => {
  await core.closeConnection();
  await rm(dataDir, { recursive: true, force: true });
});

const workflow = await readFile(path.join(ROOT, '.github/workflows/fly-e2e.yml'), 'utf8');
const payload = JSON.parse(await readFile(path.join(ROOT, '.github/fly-e2e/mcp-automation-definition.json'), 'utf8')) as Record<string, unknown>;
// The workflow fills in its fixture repository the same way.
const body = { ...payload, repositories: [REPOSITORY] };

function request(options: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    user: { id: OWNER, username: OWNER, accessToken: 'gho_fixture' },
    authenticationMethod: 'github_bearer',
    params: options.params ?? {},
    body: options.body ?? {},
    query: {},
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

async function call(route: RequestHandler, req: Request) {
  const state: { status: number; body?: any } = { status: 200 }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = {
    headersSent: false,
    status(code: number) { state.status = code; return this; },
    json(value: unknown) { state.body = value; return this; },
    end() { return this; },
  } as unknown as Response;
  await route(req, res, () => undefined);
  return state;
}

test('the workflow names the agent alias its configure step saves', () => {
  // The configure step saves the selected agent (the AGENT env, default claude) with its type as id and alias.
  const saved = [...workflow.matchAll(/saveAgents\(\[\{[^\]]*?\balias: ([^,\s]+)/g)].map(match => match[1]);
  assert.deepEqual(saved, ['type'], 'exactly one agent saved by the fixture, aliased by its type');
  assert.match(workflow, /const type = '__AGENT__';/);
  assert.match(workflow, /-e "s\/__AGENT__\/\$AGENT\/"/);
  assert.match(workflow, /AGENT: \$\{\{ inputs\.agent \|\| 'claude' \}\}/);
  // The MCP step points the payload at that same agent; the stored default matches the default agent.
  assert.match(workflow, /jq --arg repo "\$REPO" --arg agent "\$AGENT" '\.repositories = \[\$repo\] \| \.agentId = \$agent' \\\n\s+\.github\/fly-e2e\/mcp-automation-definition\.json/);
  assert.equal(payload.agentId, 'claude');
});

test('the Fly MCP payload is created and started through the REST routes under PROPR_SPRITES_MCP_TRANSPORT=forward', async () => {
  await core.runMigrations();
  // What the workflow's configure step saves for the default agent (claude).
  const { dockerImage, defaultModels } = core.AGENT_DEFAULTS.claude;
  await core.saveAgents([{ id: 'claude', type: 'claude', alias: 'claude', enabled: true,
    configPath: getManagedAgentConfigPath('claude', 'claude'), dockerImage,
    supportedModels: defaultModels, defaultModel: 'claude-sonnet-5-5' } as never]);

  const enqueued: string[] = [];
  const routes = createAutomationDefinitionRoutes({
    db: core.db,
    services: {
      resolveToken: async req => String(req.user!.accessToken),
      verifyAccess: async repository => { assert.equal(repository, REPOSITORY); },
      gate: () => null,
      trigger: input => core.triggerAgentRun(input, { enqueue: async (_name, data) => { enqueued.push(data.runId); } }),
    },
  });

  // The live run's 400: the daemon monitors the env repository, but admission reads the stored list.
  assert.deepEqual(core.getReposFromEnv(), [REPOSITORY]);
  const refused = await call(routes.create, request({ body }));
  assert.deepEqual([refused.status, refused.body], [400, { error: `Repositories are not enabled: ${REPOSITORY}`, code: 'AGENT_INVALID' }]);

  // The daemon's startup (loadAllConfigs) seeds the empty stored list from GITHUB_REPOS_TO_MONITOR;
  // the workflow no longer seeds it.
  assert.doesNotMatch(workflow, /saveMonitoredRepos/);
  assert.deepEqual(await core.seedMonitoredReposFromEnvironment(), [REPOSITORY]);
  assert.deepEqual((await core.loadMonitoredReposRaw()).map(repo => [repo.name, repo.enabled]), [[REPOSITORY, true]]);
  const created = await call(routes.create, request({ body }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const definition = created.body.definition;
  assert.deepEqual([definition.agentAlias, definition.autonomyMode, definition.capabilities, definition.repositories],
    ['claude', 'dry_run', ['repository_read', 'propr_mcp'], [REPOSITORY]]);

  const started = await call(routes.triggerRun, request({
    params: { id: definition.id }, body: { source: 'fly-e2e' }, headers: { 'Idempotency-Key': 'fly-e2e-mcp' },
  }));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.run.state, 'queued');
  assert.deepEqual(enqueued, [started.body.run.id]);

  // Admission and the worker take the same transport decision: the forward, no public URL.
  const report = await core.readAgentRuntimeCapabilityReport();
  assert.deepEqual([report.runtime, report.mcp.transport], ['sprites', 'ssh-reverse-forward']);
  const requests: string[] = [];
  const fetchImpl = (async (url: string) => {
    requests.push(url);
    return Response.json({ grantId: 'grant-1', url: 'http://api:4000/api/mcp', token: 'propr_mcp_run', expiresAt: Date.now() + 60_000, scopes: ['read'] });
  }) as unknown as typeof fetch;
  // `propr deploy fly` generates SYSTEM_TASK_SECRET; the workflow must not set it.
  assert.doesNotMatch(workflow, /echo "SYSTEM_TASK_SECRET=/);
  const grant = await requestAgentRunMcpGrant(started.body.run.id, 'report', {
    environment: { ...process.env, SYSTEM_TASK_SECRET: 'fixture-secret' }, fetchImpl,
  });
  assert.deepEqual([grant.transport, grant.url], ['ssh-reverse-forward', 'http://127.0.0.1:39080/api/mcp']);
  assert.deepEqual(requests, [`http://127.0.0.1:4000/api/internal/agent-runs/${started.body.run.id}/mcp-grants`]);
});
