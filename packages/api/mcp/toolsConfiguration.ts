import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadAgents, loadSyntheticAgents, loadMonitoredReposRaw, AGENT_DEFAULTS, AGENT_TYPES } from '@propr/core';
import { getManagedAgentConfigPath, isAgentLoginSupported, syntheticAgentConfigSchema, REASONING_LEVELS } from '@propr/shared';
import type { createConfigRoutes } from '../routes/configRoutes.js';
import { configRevision } from '../routes/configRevision.js';
import { callWorkflow } from './adapter.js';
import { McpError } from './config.js';
import { type McpTool, type ToolDeps, mutationShape, repositorySchema, idSchema, ok, workflow } from './tools.js';

const configurationId = z.string().min(1).max(256);
const agentPatch = {
  alias: z.string().regex(/^[a-z0-9-]{1,63}$/).optional(), enabled: z.boolean().optional(),
  supportedModels: z.array(configurationId).min(1).max(100).optional(), defaultModel: configurationId.optional(),
  modelCustomLabels: z.record(configurationId, z.string().max(100)).optional(),
  modelReasoningLevels: z.record(configurationId, z.enum(REASONING_LEVELS)).optional(),
  cliVersionType: z.enum(['default', 'tag', 'specific']).optional(), cliVersion: z.string().regex(/^[a-zA-Z0-9.+_-]{1,100}$/).optional(),
};
const safeAgent = (agent: Awaited<ReturnType<typeof loadAgents>>[number]) => Object.fromEntries(
  ['id', 'type', ...Object.keys(agentPatch)].filter(key => key in agent).map(key => [key, agent[key as keyof typeof agent]])
);

export function addConfigurationTools(tools: McpTool[], deps: ToolDeps, config: ReturnType<typeof createConfigRoutes>): void {
  tools.push({ name: 'get_agent_configuration', description: 'Read all direct and synthetic agent configurations and actual built-in model defaults. Credential paths/environment variables are excluded.', scope: 'manage', permission: 'instance.manage_agents', readOnly: true, schema: z.object({}).strict(), run: async () => ok({ agents: (await loadAgents()).map(safeAgent), syntheticAgents: await loadSyntheticAgents(), types: AGENT_TYPES, defaults: Object.fromEntries(Object.entries(AGENT_DEFAULTS).map(([type, value]) => [type, { models: value.defaultModels, alias: value.defaultAlias, cliVersion: value.defaultCliVersion }])), reasoningLevels: REASONING_LEVELS }) });
  for (const action of ['create', 'update', 'remove'] as const) tools.push({ name: `${action}_agent_configuration`, description: `${action} a direct agent through the existing validated configuration workflow. Creation uses managed credential storage; provider login requires secure browser setup.`, scope: 'manage', permission: 'instance.manage_agents',
    schema: z.object({ ...mutationShape, agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/), ...(action === 'create' ? { type: z.enum(AGENT_TYPES), alias: z.string().regex(/^[a-z0-9-]{1,63}$/), supportedModels: z.array(idSchema).min(1).max(100), defaultModel: idSchema, enabled: z.literal(false).default(false) } : action === 'update' ? agentPatch : {}) }).strict(), run: async ({ principal, args }) => {
      const agents = await loadAgents();
      const previous = agents.find(agent => agent.id === args.agentId);
      if ((action === 'create') === !!previous) throw new McpError('PRECONDITION_FAILED', 'Agent already exists or no longer exists.', 409);
      const patch = Object.fromEntries(Object.keys(agentPatch).filter(key => args[key] !== undefined).map(key => [key, args[key]]));
      const created = { id: args.agentId, type: args.type, ...patch, configPath: isAgentLoginSupported(args.type) ? getManagedAgentConfigPath(args.agentId, args.type) : '~/.vibe', dockerImage: '' };
      const updated = action === 'create' ? [...agents, created] : action === 'remove' ? agents.filter(agent => agent.id !== args.agentId) : agents.map(agent => agent.id === args.agentId ? { ...agent, ...patch } : agent);
      const response = await callWorkflow(config.postAgents, principal, { body: { agents: updated, expectedRevision: configRevision(agents) } });
      return ok({ agentId: args.agentId, action, warnings: (response.data as { warnings?: unknown }).warnings, ...(action === 'create' ? { enabled: false, browserSetup: `${deps.policy.config.origin}/settings` } : {}) });
    } });
  for (const action of ['create', 'update', 'remove'] as const) tools.push({ name: `${action}_synthetic_agent`, description: `${action} a synthetic agent composition. The backend validates direct model references, unique IDs, enabled members and the default agent.`, scope: 'manage', permission: 'instance.manage_agents',
    schema: z.object({ ...mutationShape, agentId: z.uuid(), ...(action !== 'remove' ? { configuration: syntheticAgentConfigSchema } : {}) }).strict(), run: async ({ principal, args }) => {
      const agents = await loadSyntheticAgents();
      const previous = agents.find(agent => agent.id === args.agentId);
      if ((action === 'create') === !!previous || (args.configuration && args.configuration.id !== args.agentId)) throw new McpError('PRECONDITION_FAILED', 'Synthetic agent identity or existence mismatch.', 409);
      const updated = action === 'create' ? [...agents, args.configuration] : action === 'remove' ? agents.filter(agent => agent.id !== args.agentId) : agents.map(agent => agent.id === args.agentId ? args.configuration : agent);
      return callWorkflow(config.postSyntheticAgents, principal, { body: { synthetic_agents: updated, expectedRevision: configRevision(agents) } });
    } });
  for (const [name, read, write, field] of [
    ['followup_keywords', config.getFollowupKeywords, config.postFollowupKeywords, 'followup_keywords'],
    ['followup_ignore_keywords', config.getFollowupIgnoreKeywords, config.postFollowupIgnoreKeywords, 'followup_ignore_keywords'],
    ['primary_processing_labels', config.getPrimaryProcessingLabels, config.postPrimaryProcessingLabels, 'primary_processing_labels'],
  ] as const) {
    workflow(tools, { name: `get_${name}`, description: `Read ${name.replaceAll('_', ' ')}.`, scope: 'manage', permission: 'instance.manage_settings', readOnly: true, schema: z.object({}).strict() }, read, () => ({}));
    workflow(tools, { name: `update_${name}`, description: `Replace ${name.replaceAll('_', ' ')} with an explicit list.`, scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, values: z.array(z.string().min(1).max(256)).max(100) }).strict() }, write, args => ({ body: { [field]: args.values } }));
  }
  for (const [name, read, write] of [['pr_label', config.getPrLabel, config.postPrLabel], ['ai_primary_tag', config.getAiPrimaryTag, config.postAiPrimaryTag]] as const) {
    workflow(tools, { name: `get_${name}`, description: `Read ${name.replaceAll('_', ' ')}.`, scope: 'manage', permission: 'instance.manage_settings', readOnly: true, schema: z.object({}).strict() }, read, () => ({}));
    workflow(tools, { name: `update_${name}`, description: `Set ${name.replaceAll('_', ' ')}.`, scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, value: z.string().min(1).max(256) }).strict() }, write, args => ({ body: { [name]: args.value } }));
  }
  workflow(tools, { name: 'get_indexing_configuration', description: 'Read indexing model/fallback policy, prompt, cooldowns and degradation state.', scope: 'manage', permission: 'instance.manage_settings', readOnly: true, schema: z.object({}).strict() }, config.getSummarizationSettings, () => ({}));
  workflow(tools, { name: 'update_indexing_configuration', description: 'Replace indexing configuration with explicit primary/fallback alias:model and prompt. Existing validation and delayed reindex behavior apply.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, enabled: z.boolean(), agent_alias: z.string().max(256), fallback_agent_alias: z.string().max(256), custom_prompt: z.string().max(65536) }).strict() }, config.postSummarizationSettings, args => ({ body: args }));
  workflow(tools, { name: 'get_provider_policy', description: 'Read the configured Agent Tank provider policy; does not return credentials.', scope: 'manage', permission: 'instance.manage_agents', readOnly: true, schema: z.object({}).strict() }, config.getAgentTankSettings, () => ({}));
  workflow(tools, { name: 'update_provider_policy', description: 'Configure the existing Agent Tank provider service with a non-secret HTTP(S) base URL and explicit enabled state. Requires instance.manage_agents.', scope: 'manage', permission: 'instance.manage_agents', schema: z.object({ ...mutationShape, enabled: z.boolean(), url: z.url().max(2048).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'; }, 'Use an HTTP(S) origin without credentials, path, query or fragment') }).strict() }, config.postAgentTankSettings, args => ({ body: { enabled: args.enabled, url: args.url.replace(/\/$/, '') } }));
  for (const [name, handler] of [['get_provider_status', config.getAgentTankStatus], ['get_provider_usage', config.getAgentTankUsage], ['detect_provider_service', config.getAgentTankDetect]] as const) workflow(tools, { name, description: 'Read the existing configured Agent Tank provider service state.', scope: 'manage', permission: 'instance.manage_agents', readOnly: true, schema: z.object({}).strict() }, handler, () => ({}));
  workflow(tools, { name: 'refresh_provider_usage', description: 'Refresh usage from the existing configured Agent Tank service.', scope: 'manage', permission: 'instance.manage_agents', schema: z.object(mutationShape).strict() }, config.postAgentTankRefresh, () => ({}));
  for (const action of ['create', 'remove'] as const) tools.push({ name: `${action}_repository_configuration`, description: `${action} a repository configuration under instance administration and explicit repository grants. Missing consent returns browser continuation without changing configuration.`, scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, repository: repositorySchema, ...(action === 'create' ? { baseBranch: idSchema, enabled: z.boolean().default(true), alias: idSchema.optional() } : {}) }).strict(), run: async ({ principal, args }) => {
    if (!principal.grant.repositories.some(repo => repo.toLowerCase() === args.repository.toLowerCase())) return ok({ state: 'browser_required', changed: false, reason: 'repository_consent_expansion_required', repository: args.repository, continuation: { browserUrl: principal.grant.membershipSource === 'connect' ? 'https://connect.propr.dev/connected-apps' : `${deps.policy.config.origin}/mcp/apps`, instructions: 'Configure the repository in browser settings and reconnect with it selected. This tool cannot expand a grant.' } });
    await deps.policy.repository(principal, args.repository, true, { includeDisabled: true, allowUnconfigured: true });
    const repos = await loadMonitoredReposRaw();
    const existing = repos.find(repo => repo.name.toLowerCase() === args.repository.toLowerCase());
    if ((action === 'create') === !!existing) throw new McpError('PRECONDITION_FAILED', 'Repository already exists or no longer exists.', 409);
    const updated = action === 'create' ? [...repos, { id: randomUUID(), name: args.repository, baseBranch: args.baseBranch, alias: args.alias, enabled: args.enabled }] : repos.filter(repo => repo !== existing);
    await callWorkflow(config.postRepos, principal, { body: { repos_to_monitor: updated, expectedRevision: configRevision(repos) } });
    return ok({ repository: args.repository, action, changed: true });
  } });
}
