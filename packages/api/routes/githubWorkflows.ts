import { parse } from 'yaml';

/** Events GitHub reports for a pull request's own runs, the only ones follow-up CI cancellation may cancel. */
const PULL_REQUEST_EVENTS = new Set(['pull_request', 'pull_request_target']);
/** Bounds the workflow files read for one listing; a repository with more still lists them, without triggers. */
const MAX_WORKFLOW_FILES_READ = 50;

export interface RepositoryWorkflow {
  id: number;
  name: string;
  path: string;
  /** The workflow file name, the identity the settings picker stores. */
  file: string;
  /** Events from the file's `on:` key; null when the file could not be read or parsed. */
  triggers: string[] | null;
  /** Whether GitHub runs this workflow for pull requests; null when unknown. */
  pullRequest: boolean | null;
}

interface WorkflowListingOctokit {
  request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
  paginate: { iterator: (route: string, params: Record<string, unknown>) => AsyncIterable<{ data: unknown }> };
}

interface GitHubWorkflow { id: number; name: string; path: string; state: string }

/** Top-level trigger names of a workflow file, or null when it is not a readable workflow. */
export function workflowTriggers(source: string): string[] | null {
  let document: unknown;
  try { document = parse(source); } catch { return null; }
  if (!document || typeof document !== 'object') return null;
  // YAML 1.2 keeps `on` a string key; it is not the YAML 1.1 boolean.
  const on = (document as Record<string, unknown>).on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((event): event is string => typeof event === 'string');
  if (on && typeof on === 'object') return Object.keys(on);
  return null;
}

async function readWorkflowFile(octokit: WorkflowListingOctokit, owner: string, repo: string, path: string): Promise<string | null> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path, headers: { accept: 'application/vnd.github.raw+json' },
    });
    return typeof data === 'string' ? data : null;
  } catch (error) {
    // Access to the repository itself is decided by the listing; one unreadable file only loses its triggers.
    const status = (error as { status?: number })?.status;
    if (status === 401) throw error;
    return null;
  }
}

/**
 * The repository's active workflow files, pull-request workflows first. Dynamic
 * workflows (Dependabot, Copilot and similar) have no file an operator could select.
 */
export async function listRepositoryWorkflows(octokit: WorkflowListingOctokit, owner: string, repo: string): Promise<RepositoryWorkflow[]> {
  const listed: GitHubWorkflow[] = [];
  for await (const response of octokit.paginate.iterator('GET /repos/{owner}/{repo}/actions/workflows', { owner, repo, per_page: 100 })) {
    for (const workflow of response.data as GitHubWorkflow[]) {
      if (workflow.state === 'active' && workflow.path?.startsWith('.github/workflows/')) listed.push(workflow);
    }
  }
  const workflows = await Promise.all(listed.map(async (workflow, index): Promise<RepositoryWorkflow> => {
    const source = index < MAX_WORKFLOW_FILES_READ ? await readWorkflowFile(octokit, owner, repo, workflow.path) : null;
    const triggers = source === null ? null : workflowTriggers(source);
    return {
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      file: workflow.path.split('/').pop() ?? workflow.path,
      triggers,
      pullRequest: triggers ? triggers.some(event => PULL_REQUEST_EVENTS.has(event)) : null,
    };
  }));
  const rank = (workflow: RepositoryWorkflow) => (workflow.pullRequest === true ? 0 : workflow.pullRequest === null ? 1 : 2);
  return workflows.sort((a, b) => rank(a) - rank(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
