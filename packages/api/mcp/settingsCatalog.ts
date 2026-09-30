/** Machine-readable counterpart of docs/mcp-coverage.md#settings-reachability. */
export type SettingsReachabilityStatus = 'covered' | 'added in this issue' | 'intentionally browser-only';

export interface SettingsCatalogEntry {
  setting: string;
  uiLocation: string;
  mcpRead: string | null;
  mcpWrite: string | null;
  cli: boolean;
  env: string[];
  status: SettingsReachabilityStatus;
  reason?: string;
}

const execution = (setting: string, uiLocation: string, env: string[] = [], status: SettingsReachabilityStatus = 'covered'): SettingsCatalogEntry => ({
  setting, uiLocation, mcpRead: 'get_execution_settings', mcpWrite: 'update_execution_settings', cli: true, env, status,
});

export const SETTINGS_CATALOG: readonly SettingsCatalogEntry[] = [
  execution('usage_tips_enabled', 'Settings > Automation > Usage tips', [], 'added in this issue'),
  execution('usage_tips_dismissal_cooldown_days', 'Settings > Automation > Usage tips', [], 'added in this issue'),
  execution('default_agent_alias', 'Settings > Models > Model selection'),
  execution('worker_concurrency', 'Settings > Automation > General configuration', ['WORKER_CONCURRENCY']),
  { setting: 'github_user_whitelist (users)', uiLocation: 'Settings > Automation > GitHub User Whitelist', mcpRead: 'get_trigger_access_configuration', mcpWrite: 'update_trigger_access_configuration', cli: true, env: ['GITHUB_USER_WHITELIST'], status: 'added in this issue' },
  { setting: 'github_user_whitelist ([bot] entries)', uiLocation: 'Settings > Automation > GitHub User Whitelist', mcpRead: 'get_trigger_access_configuration', mcpWrite: 'update_trigger_access_configuration', cli: true, env: ['GITHUB_USER_WHITELIST'], status: 'added in this issue' },
  { setting: 'GITHUB_USER_BLACKLIST', uiLocation: 'Not editable in UI', mcpRead: 'get_trigger_access_configuration', mcpWrite: null, cli: false, env: ['GITHUB_USER_BLACKLIST'], status: 'added in this issue', reason: 'Environment-owned deny list is intentionally read-only.' },
  execution('analysis_model_fast', 'Settings > Models > Model selection', ['ANALYSIS_MODEL_FAST']),
  execution('planner_context_model', 'Settings > Models > Model selection', ['PLANNER_CONTEXT_MODEL']),
  execution('planner_generation_model', 'Settings > Models > Model selection', ['PLANNER_GENERATION_MODEL']),
  execution('auto_followup_score_threshold', 'Settings > Automation > General configuration'),
  execution('auto_resolve_merge_conflicts', 'Settings > Automation > General configuration'),
  execution('dashboard_summary_enabled', 'Settings > Models > Model selection', [], 'added in this issue'),
  execution('model_reasoning_level', 'Settings > Models > Model selection'),
  execution('pr_review_model', 'Settings > Models > PR review'),
  execution('pr_review_prompt', 'Settings > Models > PR review'),
  execution('pr_review_context_enabled', 'Settings > Models > PR review context'),
  execution('pr_review_context_model', 'Settings > Models > PR review context'),
  execution('pr_review_max_context_tokens', 'Settings > Models > PR review context (legacy cap)'),
  execution('pr_review_context_budget_percent', 'Settings > Models > PR review context'),
  execution('ultrafix_rating_goal', 'Settings > Automation > General configuration'),
  execution('ultrafix_max_cycles', 'Settings > Automation > General configuration'),
  execution('ultrafix_pause_seconds', 'Settings > Automation > General configuration'),
  { setting: 'pr_label', uiLocation: 'Settings > Automation > PR label', mcpRead: 'get_pr_label', mcpWrite: 'update_pr_label', cli: true, env: ['PR_LABEL'], status: 'covered' },
  { setting: 'ai_primary_tag', uiLocation: 'Not exposed in Settings UI', mcpRead: 'get_ai_primary_tag', mcpWrite: 'update_ai_primary_tag', cli: true, env: ['AI_PRIMARY_TAG'], status: 'covered' },
  { setting: 'primary_processing_labels', uiLocation: 'Settings > Automation > Primary processing labels', mcpRead: 'get_primary_processing_labels', mcpWrite: 'update_primary_processing_labels', cli: true, env: [], status: 'covered' },
  { setting: 'followup_keywords', uiLocation: 'Settings > Automation > Follow-up keywords', mcpRead: 'get_followup_keywords', mcpWrite: 'update_followup_keywords', cli: true, env: ['PR_FOLLOWUP_TRIGGER_KEYWORDS'], status: 'covered' },
  { setting: 'followup_ignore_keywords', uiLocation: 'Settings > Automation > PR follow-up ignore keywords', mcpRead: 'get_followup_ignore_keywords', mcpWrite: 'update_followup_ignore_keywords', cli: false, env: [], status: 'covered' },
  { setting: 'indexing policy', uiLocation: 'Settings > Models > Knowledge base', mcpRead: 'get_indexing_configuration', mcpWrite: 'update_indexing_configuration', cli: false, env: [], status: 'covered' },
  { setting: 'Agent Tank policy', uiLocation: 'Settings > Integrations > Agent Tank', mcpRead: 'get_provider_policy', mcpWrite: 'update_provider_policy', cli: false, env: [], status: 'covered' },
  { setting: 'direct and synthetic agents', uiLocation: 'Settings > Models > Coding agents', mcpRead: 'get_agent_configuration', mcpWrite: 'create_agent_configuration / update_agent_configuration / remove_agent_configuration / create_synthetic_agent / update_synthetic_agent / remove_synthetic_agent', cli: true, env: [], status: 'covered' },
  { setting: 'agent runtime packages', uiLocation: 'Settings > Integrations > Agent runtime packages', mcpRead: 'get_runtime_configuration', mcpWrite: 'update_runtime_configuration', cli: false, env: [], status: 'covered' },
  { setting: 'repository identity, branch, alias and enabled', uiLocation: 'Repositories > configuration', mcpRead: 'get_repository_configuration', mcpWrite: 'create_repository_configuration / update_repository_configuration / remove_repository_configuration', cli: true, env: ['REPOS_TO_MONITOR'], status: 'covered' },
  { setting: 'repository failed-CI follow-up and cancellation policy', uiLocation: 'Repositories > automation', mcpRead: 'get_repository_configuration', mcpWrite: 'update_repository_configuration', cli: false, env: [], status: 'covered' },
  { setting: 'repository non-blocking checks', uiLocation: 'Repositories > automation', mcpRead: 'get_repository_configuration', mcpWrite: 'update_repository_configuration', cli: false, env: [], status: 'covered' },
  { setting: 'repository notifications', uiLocation: 'Repositories > notifications', mcpRead: 'get_repository_configuration', mcpWrite: 'update_repository_configuration', cli: false, env: [], status: 'covered' },
  { setting: 'repository visual preview policy', uiLocation: 'Repositories > visual previews', mcpRead: 'get_repository_configuration', mcpWrite: 'update_repository_configuration', cli: false, env: [], status: 'covered' },
  { setting: 'notification preferences and quiet hours', uiLocation: 'Settings > Notifications', mcpRead: 'get_notification_preferences', mcpWrite: 'update_notification_preferences / set_notification_category_preferences', cli: false, env: [], status: 'covered' },
  { setting: 'MCP enablement, origin, instance identity, encryption and scope ceiling', uiLocation: 'Settings > Integrations > MCP server', mcpRead: null, mcpWrite: null, cli: false, env: ['MCP_ENABLED', 'MCP_PUBLIC_ORIGIN', 'MCP_INSTANCE_ID', 'MCP_ENCRYPTION_KEY', 'MCP_SCOPE_CEILING'], status: 'intentionally browser-only', reason: 'Changes the authorization boundary or the server identity used to authenticate MCP itself.' },
  { setting: 'agent/provider credentials and credential paths', uiLocation: 'Settings > Models > Coding agents', mcpRead: null, mcpWrite: null, cli: true, env: [], status: 'intentionally browser-only', reason: 'Secret entry and host credential paths are never exposed to MCP.' },
  { setting: 'managed preview storage credentials', uiLocation: 'Settings > Integrations > Managed preview storage', mcpRead: null, mcpWrite: null, cli: false, env: [], status: 'intentionally browser-only', reason: 'Contains storage credentials and host trust configuration.' },
  { setting: 'voice and desktop notification preferences', uiLocation: 'Settings > Notifications', mcpRead: null, mcpWrite: null, cli: false, env: [], status: 'intentionally browser-only', reason: 'Device-local browser/desktop capabilities are not instance configuration.' },
] as const;
