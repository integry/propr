export interface Settings {
  worker_concurrency: string;
  analysis_model_fast: string;
  analysis_model_advanced: string;
  planner_context_model: string;
  planner_generation_model: string;
  // github_user_whitelist is now handled as string[] in main state
}

export interface AlertProps {
  message: string;
  type: 'error' | 'success';
}
