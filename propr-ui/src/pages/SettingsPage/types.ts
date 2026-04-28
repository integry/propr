export interface Settings {
  worker_concurrency: string;
  analysis_model_fast: string;
  planner_context_model: string;
  planner_generation_model: string;
  default_agent_alias: string;
  auto_followup_score_threshold: number;
  auto_resolve_merge_conflicts: boolean;
  pr_review_model: string;
  ultrafix_rating_goal: number;
  ultrafix_max_cycles: number;
  ultrafix_pause_seconds: number;
  // github_user_whitelist is now handled as string[] in main state
}

export interface AlertProps {
  message: string;
  type: 'error' | 'success';
}
