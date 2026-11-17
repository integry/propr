import { useSearchParams } from 'react-router-dom';
import { TASK_SEARCH_MAX_LENGTH } from '../TaskList/searchLimits';

/** The Automations list filters kept in the URL: `?repository=` and `?search=`, as on the Goals and Plans lists. */
export const AUTOMATION_REPOSITORY_PARAM = 'repository';
export const AUTOMATION_SEARCH_PARAM = 'search';
/** The same search length limit as the other lists. */
export const AUTOMATION_SEARCH_MAX_LENGTH = TASK_SEARCH_MAX_LENGTH;

/**
 * `?repository=…&search=…` for the list filters in `params`, or '' when none
 * is set. The list stays beside an open automation, whose address is a path
 * of its own, so every link and navigation between the list, an automation
 * and its runs carries this along; otherwise selecting a row would clear the
 * filters it was found with.
 */
export const automationListQuery = (params: URLSearchParams): string => {
  const kept = new URLSearchParams();
  for (const key of [AUTOMATION_REPOSITORY_PARAM, AUTOMATION_SEARCH_PARAM]) {
    const value = params.get(key);
    if (value) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : '';
};

/** The current list filters as a query string to append to an `/automations…` path. */
export function useAutomationListQuery(): string {
  const [params] = useSearchParams();
  return automationListQuery(params);
}
