export interface Settings {
  worker_concurrency: string;
  max_provider_replacements: number;
  analysis_model_fast: string;
  planner_context_model: string;
  planner_generation_model: string;
  default_agent_alias: string;
  usage_tips_enabled?: boolean;
  usage_tips_dismissal_cooldown_days?: number;
  auto_resolve_merge_conflicts: boolean;
  dashboard_summary_enabled?: boolean;
  model_reasoning_level: string;
  pr_review_model: string;
  pr_review_prompt: string;
  pr_review_context_enabled: boolean;
  pr_review_context_model: string;
  /** Retained legacy absolute cap; 0 when none. */
  pr_review_max_context_tokens: number;
  pr_review_context_budget_percent: number;
  ultrafix_escalation_enabled: boolean;
  ultrafix_escalation_models: string[];
  ultrafix_escalation_patience: number;
  ultrafix_escalation_max_reasoning_levels: number;
  ultrafix_rating_goal: number;
  ultrafix_max_cycles: number;
  ultrafix_pause_seconds: number;
  /** Instance default per-run spend cap in USD as typed; empty or 0 = no cap. */
  default_max_cost_usd: string;
  /** Unattended agent run limits; changes save immediately on their own. */
  agent_run_usage_pause_percent: number;
  unattended_max_concurrent: number;
  /** HH:MM-HH:MM@Time/Zone, or empty for no window. */
  unattended_window: string;
  /** Why the stored window is unusable (unattended runs are blocked), from the server. */
  unattended_window_error?: string;
  /** Watchdog overrides; null uses the environment default. */
  agent_stall_timeout_ms: number | null;
  agent_tool_stall_timeout_ms: number | null;
  agent_degenerate_output_limit: number | null;
  /** Environment defaults reported by the server (read-only). */
  agent_watchdog_defaults?: Partial<Record<AgentWatchdogSettingName, number>>;
  /** Network policy overrides; null uses the environment default. */
  agent_network_mode: 'open' | 'restricted' | null;
  agent_network_mode_enforced: boolean | null;
  agent_network_allow: string[] | null;
  agent_network_ignore_repository_allow: boolean | null;
  /** Environment defaults reported by the server (read-only). */
  agent_network_defaults?: AgentNetworkDefaults;
  // github_user_whitelist is now handled as string[] in main state
}

export type UnattendedSettingName = 'agent_run_usage_pause_percent' | 'unattended_max_concurrent' | 'unattended_window';
export interface UnattendedSettingValues {
  agent_run_usage_pause_percent: number;
  unattended_max_concurrent: number;
  unattended_window: string;
}

export type AgentWatchdogSettingName = 'agent_stall_timeout_ms' | 'agent_tool_stall_timeout_ms' | 'agent_degenerate_output_limit';
export type AgentWatchdogValues = Record<AgentWatchdogSettingName, number | null>;
export type AgentNetworkSettingName = 'agent_network_mode' | 'agent_network_mode_enforced' | 'agent_network_allow' | 'agent_network_ignore_repository_allow';
export interface AgentNetworkValues {
  agent_network_mode: 'open' | 'restricted' | null;
  agent_network_mode_enforced: boolean | null;
  agent_network_allow: string[] | null;
  agent_network_ignore_repository_allow: boolean | null;
}
export interface AgentNetworkDefaults {
  agent_network_mode?: 'open' | 'restricted';
  agent_network_mode_enforced?: boolean;
  agent_network_allow?: string[];
  agent_network_ignore_repository_allow?: boolean;
}

export interface AlertProps {
  message: string;
  type: 'error' | 'success' | 'warning';
}
