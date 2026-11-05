import { useEffect, useState } from 'react';
import { getRepoWorkflows } from '../api/proprApi';
import type { RepoWorkflow } from '../api/proprTypes';

export interface RepoWorkflowsState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  workflows: RepoWorkflow[];
}

// One request per repository per page load: the settings list re-renders on every poll.
const requests = new Map<string, Promise<RepoWorkflow[]>>();

/** For tests: forget cached listings. */
export function clearRepoWorkflowsCache(): void {
  requests.clear();
}

/** The workflow files GitHub reports for `owner/repo`, fetched only while `enabled`. */
export function useRepoWorkflows(repository: string, enabled: boolean): RepoWorkflowsState {
  const [state, setState] = useState<RepoWorkflowsState>({ status: 'idle', workflows: [] });

  useEffect(() => {
    const [owner, repo] = repository.split('/');
    if (!enabled || !owner || !repo) return;
    let active = true;
    const key = repository.toLowerCase();
    let request = requests.get(key);
    if (!request) {
      request = getRepoWorkflows(owner, repo).then(response => response.workflows);
      requests.set(key, request);
      // A failed listing is retried the next time the control opens.
      request.catch(() => requests.delete(key));
    }
    setState(current => ({ status: 'loading', workflows: current.workflows }));
    request.then(
      workflows => { if (active) setState({ status: 'loaded', workflows }); },
      () => { if (active) setState({ status: 'error', workflows: [] }); },
    );
    return () => { active = false; };
  }, [repository, enabled]);

  return state;
}
