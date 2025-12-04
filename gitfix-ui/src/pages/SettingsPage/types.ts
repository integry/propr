export interface Settings {
  worker_concurrency: string;
  github_user_whitelist: string;
  analysis_model_fast: string;
  analysis_model_advanced: string;
  pr_label: string;
}

export interface AlertProps {
  message: string;
  type: 'error' | 'success';
}
