/**
 * Where an Analytics row leads: the filtered list behind its figures.
 *
 * Those lists are not scoped to a period, so a drill-down opens everything
 * for the repository or model rather than only the window the
 * console is showing.
 */

/** `/tasks` filtered to a repository, and optionally a status. */
export const tasksHref = (repository: string, status?: string): string => {
  const params = new URLSearchParams({ repository });
  if (status) params.set('status', status);
  return `/tasks?${params.toString()}`;
};

/** The LLM log filtered to one model. */
export const modelLogsHref = (model: string): string => `/llm-logs?${new URLSearchParams({ model }).toString()}`;
