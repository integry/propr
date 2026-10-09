import { area } from '../lib/world';
import { AGENT_DEFAULTS, AGENT_MODELS, type AgentType } from '@propr/shared';
import { AGENTS, REPOS } from './base';

/**
 * The instance catalog in its real shape (`InstanceCatalogResponse`: repositories carry `name`).
 * Remove once world/base.ts serves this shape itself.
 */
export const catalog = area('catalog', {
  '/api/instance/catalog': {
    agents: AGENTS.map(agent => ({ id: agent.id, kind: 'direct', alias: agent.alias, type: agent.type, enabled: true, supportedModels: agent.supportedModels })),
    repositories: Object.values(REPOS).map(name => ({ name, enabled: true, baseBranch: 'main' })),
    defaultAgentAlias: 'claude',
  },
});

export const agentTank = (mode: 'disabled' | 'bundled' | 'external') => area('agent-tank', {
  '/api/config/agent-tank': { mode, enabled: mode !== 'disabled', url: 'http://host.docker.internal:3456' },
  '/api/config/agent-tank/status': { mode, available: true },
  '/api/config/agent-tank/detect': { detected: false },
});

const routing: Record<string, [boolean, boolean]> = {
  plan: [true, true], task: [true, false], review: [true, true], pull_request: [true, true], indexing: [false, false], system_failure: [true, true],
};

/** Personal notification routing: Inbox and Push per category, quiet hours overnight. */
export const notificationPreferences = area('notification-preferences', {
  '/api/notifications/preferences': {
    preferences: Object.fromEntries(Object.entries(routing).map(([kind, [inboxEnabled, pushEnabled]]) => [kind, { inboxEnabled, pushEnabled, updatedAt: null }])),
    quietHours: { start: '22:00', end: '07:00', timezone: 'Europe/Lisbon' },
    badgeEnabled: true,
  },
});

/** The five supported coding agents, configured and ready (overrides base AGENTS). */
export const codingAgents = (() => {
  const defaults: Record<AgentType, string> = { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol', vibe: 'mistral-medium-3.5', antigravity: 'antigravity-gemini-3.1-pro', opencode: 'opencode-big-pickle' };
  const agents = (Object.keys(defaults) as AgentType[]).map(type => ({
    id: `${type}-config`, type, alias: type, enabled: type !== 'opencode', dockerImage: 'propr/agent:latest',
    configPath: AGENT_DEFAULTS[type].configPath, supportedModels: AGENT_MODELS[type].map(model => model.id), defaultModel: defaults[type],
  }));
  return area('coding-agents', {
    '/api/config/agents': { agents },
    '/api/config/synthetic-agents': { synthetic_agents: [] },
    '/api/instance/catalog': {
      agents: agents.filter(agent => agent.enabled).map(agent => ({ id: agent.id, kind: 'direct', alias: agent.alias, type: agent.type, enabled: true, supportedModels: agent.supportedModels })),
      repositories: Object.values(REPOS).map(name => ({ name, enabled: true, baseBranch: 'main' })),
      defaultAgentAlias: 'claude',
    },
  }, [[/^\/api\/agents\/[^/]+\/health$/, request => ({ agentId: request.path.split('/')[3], status: 'ready', model: 'claude-opus-5-5' })]]);
})();

/** Per-phase model choices on the Models tab. */
export const phaseModels = area('phase-models', {
  '/api/config/settings': {
    worker_concurrency: 4, auto_followup_score_threshold: 4, auto_resolve_merge_conflicts: true,
    ultrafix_rating_goal: 8, ultrafix_max_cycles: 5, ultrafix_pause_seconds: 60,
    default_agent_alias: 'claude', model_reasoning_level: 'high', dashboard_summary_enabled: true,
    planner_context_model: 'claude:claude-sonnet-5-5', planner_generation_model: 'claude:claude-opus-5-5',
    pr_review_model: 'codex:gpt-6.1-sol', analysis_model_fast: 'claude:claude-sonnet-5-5',
    pr_review_context_enabled: true, pr_review_context_model: 'claude:claude-sonnet-5-5', github_user_whitelist: [],
  },
});
