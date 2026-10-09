import { area } from '../lib/world';

/**
 * Northwind Labs: the fictional team every capture shows. Keep names here so
 * screens agree with each other (the same repos, people and agents everywhere).
 */
export const NOW = new Date('2026-10-08T14:30:00Z');
export const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
export const hoursAgo = (hours: number) => minutesAgo(hours * 60);
export const daysAgo = (days: number) => minutesAgo(days * 1440);

export const ORG = 'northwind';
export const REPOS = {
  web: `${ORG}/storefront-web`,
  api: `${ORG}/orders-api`,
  mobile: `${ORG}/courier-app`,
  infra: `${ORG}/platform-infra`,
} as const;

export const USER = {
  id: 'u-maya', login: 'maya-ortiz', username: 'maya-ortiz', displayName: 'Maya Ortiz',
  email: null, avatarUrl: null, role: 'admin', authorizationSource: 'local',
  permissions: ['instance.manage_agents', 'instance.manage_members', 'instance.manage_runtime', 'instance.manage_settings'],
};

/** Real agent types and model ids (packages/shared/src/modelDefinitions.ts), so the UI shows proper labels. */
export const AGENTS = [
  { id: 'claude', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent:latest', configPath: '~/.claude', supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' },
  { id: 'codex', type: 'codex', alias: 'codex', enabled: true, dockerImage: 'propr/agent:latest', configPath: '~/.codex', supportedModels: ['gpt-6-astra', 'gpt-5.5'], defaultModel: 'gpt-6-astra' },
  { id: 'antigravity', type: 'antigravity', alias: 'antigravity', enabled: true, dockerImage: 'propr/agent:latest', configPath: '~/.gemini', supportedModels: ['antigravity-gemini-3.1-pro'], defaultModel: 'antigravity-gemini-3.1-pro' },
];

export const REPO_ALIASES: Record<string, string> = {
  [REPOS.web]: 'Storefront', [REPOS.api]: 'Orders API', [REPOS.mobile]: 'Courier app', [REPOS.infra]: 'Platform infra',
};

export const base = area('base', {
  '/api/auth/demo-mode': { demoMode: false },
  '/api/auth/user': USER,
  '/api/config/settings': {
    worker_concurrency: 4, auto_followup_score_threshold: 4, auto_resolve_merge_conflicts: true,
    ultrafix_rating_goal: 8, ultrafix_max_cycles: 5, ultrafix_pause_seconds: 60,
    default_agent_alias: 'claude', model_reasoning_level: '', planner_context_model: '',
    planner_generation_model: '', pr_review_model: 'claude:claude-opus-5-5', analysis_model_fast: '',
    pr_review_context_enabled: true, pr_review_context_model: '', github_user_whitelist: [],
  },
  '/api/config/followup-keywords': { followup_keywords: [] },
  '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
  '/api/config/pr-label': { pr_label: 'propr' },
  '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
  '/api/config/agents': { agents: AGENTS },
  '/api/config/summarization': { enabled: false, agent_alias: '', fallback_agent_alias: '' },
  '/api/instance/catalog': {
    agents: AGENTS.map(({ id, type, alias, supportedModels, defaultModel }) => ({ id, kind: 'direct', type, alias, enabled: true, supportedModels, defaultModel })),
    defaultAgentAlias: 'claude',
    repositories: Object.values(REPOS).map(name => ({ name, enabled: true, alias: REPO_ALIASES[name], baseBranch: 'main' })),
  },
  '/api/notifications/config': { push: { configured: true, vapidPublicKey: null } },
  '/api/notifications/unread-count': { unreadCount: 3 },
  // App chrome: sidebar badges, status light and review counts. Areas override these when a screen needs real rows.
  '/api/status': { status: 'ok' },
  '/api/queue/stats': { active: 3, waiting: 1, completed: 214, failed: 4 },
  '/api/stats/generating-plans': { count: 0 },
  '/api/planner/drafts': { drafts: [], total: 0 },
  '/api/tasks': { tasks: [], total: 0 },
  '/api/notifications/preferences': { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: true },
});
