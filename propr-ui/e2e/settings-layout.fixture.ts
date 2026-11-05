import type { Locator, Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** API fixture for the Settings layout specs: one admin user and a populated instance. */

const notificationPreferences = Object.fromEntries([
  'plan', 'task', 'review', 'pull_request', 'indexing', 'system_failure',
].map(kind => [kind, { inboxEnabled: true, pushEnabled: kind === 'system_failure', updatedAt: null }]));

const catalogAgents = [
  { id: 'claude', kind: 'direct' as const, alias: 'claude', enabled: true, supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  { id: 'codex', kind: 'direct' as const, alias: 'codex', enabled: true, supportedModels: ['gpt-5-codex', 'gpt-6-astra'] },
];

export async function installSettingsFixture(page: Page): Promise<void> {
  let savedSettings: Record<string, unknown> = {};
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: 'preview-user', login: 'preview', username: 'preview', displayName: 'Preview User',
        email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'],
        authorizationSource: 'local',
      },
      '/api/config/settings': {
        worker_concurrency: 2,
        auto_followup_score_threshold: 4,
        auto_resolve_merge_conflicts: true,
        ultrafix_rating_goal: 7,
        ultrafix_max_cycles: 5,
        ultrafix_pause_seconds: 60,
        default_agent_alias: 'claude',
        model_reasoning_level: 'high',
        planner_context_model: 'claude:claude-sonnet-5-5',
        planner_generation_model: 'claude:claude-opus-5-5',
        pr_review_model: 'claude:claude-opus-5-5',
        analysis_model_fast: 'codex:gpt-5-codex',
        pr_review_context_enabled: true,
        pr_review_context_model: '',
        pr_review_max_context_tokens: 0,
        pr_review_context_budget_percent: 100,
        github_user_whitelist: ['octocat', 'hubot'],
        agent_stall_timeout_ms: 300_000,
        agent_tool_stall_timeout_ms: null,
        agent_degenerate_output_limit: null,
        agent_watchdog_defaults: { agent_stall_timeout_ms: 600_000, agent_tool_stall_timeout_ms: 1_800_000, agent_degenerate_output_limit: 50 },
        agent_network_mode: 'restricted',
        agent_network_mode_enforced: null,
        agent_network_allow: ['registry.example.com', '*.internal.example.com'],
        agent_network_ignore_repository_allow: true,
        agent_network_defaults: { agent_network_mode: 'open', agent_network_mode_enforced: false, agent_network_allow: [], agent_network_ignore_repository_allow: false },
      },
      '/api/config/followup-keywords': { followup_keywords: ['PROPR', 'FIXIT'] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: ['Deployment In Progress'] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents: [] },
      '/api/config/summarization': { enabled: true, agent_alias: 'claude:claude-sonnet-5-5', fallback_agent_alias: '' },
      '/api/config/agent-tank': { enabled: true, url: 'http://0.0.0.0:3456' },
      '/api/config/agent-tank/status': { available: true },
      '/api/config/visual-preview-auth': {
        status: 'active', source: 'github_login', configured: true, githubUsername: 'preview-bot',
      },
      '/api/config/preview-storage': { version: 1, state: 'enabled', enabled: true, effective: null },
      '/api/agent-runtime/packages': {
        installationId: 'preview', packages: ['ripgrep'], activePackages: ['ripgrep'],
        status: 'ready', images: { claude: 'sha256:preview' }, updatedAt: '',
      },
      '/api/admin/mcp': {
        status: { enabled: true, resource: 'https://propr.example/api/mcp', origin: 'https://propr.example', scopeCeiling: ['read', 'plan', 'execute'] },
        settings: { enabled: true, scopeCeiling: ['read', 'plan', 'execute'], connectEnabled: false },
      },
      '/api/instance/catalog': { agents: catalogAgents, repositories: [] },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': {
        preferences: notificationPreferences,
        quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' },
        badgeEnabled: true,
      },
    };
    if (pathname === '/api/config/settings') {
      if (route.request().method() === 'POST') {
        savedSettings = { ...savedSettings, ...route.request().postDataJSON().settings };
        return route.fulfill({ json: { success: true, settings: savedSettings } });
      }
      return route.fulfill({ json: { ...(responses[pathname] as Record<string, unknown>), ...savedSettings } });
    }
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in settings layout fixture' } });
  });
}

export async function capture(page: Page, name: string, scrollTo?: Locator): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  if (scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}
