import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

export interface GoalArtifact {
    type: 'pull_request' | 'issue';
    number: number;
    url: string;
    state?: string;
    draft?: boolean;
}

export interface GoalArtifactStats {
    issues: number;
    openIssues: number;
    pullRequests: number;
    openPullRequests: number;
}

interface GoalArtifactContext {
    repository: string;
    branchName: string | null;
    baseBranch: string | null;
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

function repositoryUrlPattern(repository: string): RegExp {
    const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`https://github\\.com/${escaped}/(pull|issues)/(\\d+)\\b`, 'gi');
}

function isRepositoryArtifact(repository: string, artifact: GoalArtifact): boolean {
    if (!Number.isSafeInteger(artifact.number) || artifact.number < 1) return false;
    const path = artifact.type === 'pull_request' ? 'pull' : artifact.type === 'issue' ? 'issues' : null;
    if (!path) return false;
    return artifact.url === `https://github.com/${repository}/${path}/${artifact.number}`;
}

export function discoverRepositoryArtifacts(repository: string, output: string): GoalArtifact[] {
    const artifacts = new Map<string, GoalArtifact>();
    for (const match of output.matchAll(repositoryUrlPattern(repository))) {
        const url = `https://github.com/${repository}/${match[1].toLowerCase()}/${match[2]}`;
        artifacts.set(url, {
            type: match[1].toLowerCase() === 'pull' ? 'pull_request' : 'issue',
            number: Number(match[2]),
            url,
        });
    }
    return [...artifacts.values()];
}

export function parseGoalArtifacts(value: string | GoalArtifact[] | null | undefined): GoalArtifact[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed as GoalArtifact[] : [];
    } catch {
        return [];
    }
}

async function validateArtifact(
    octokit: Octokit,
    owner: string,
    repo: string,
    artifact: GoalArtifact,
): Promise<GoalArtifact | null> {
    try {
        if (artifact.type === 'pull_request') {
            const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner, repo, pull_number: artifact.number,
            });
            return {
                ...artifact,
                url: response.data.html_url,
                state: response.data.state,
                draft: response.data.draft ?? false,
            };
        }
        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner, repo, issue_number: artifact.number,
        });
        if ('pull_request' in response.data) return null;
        return { ...artifact, url: response.data.html_url, state: response.data.state };
    } catch {
        return null;
    }
}

async function findExpectedFinalPr(
    octokit: Octokit,
    context: GoalArtifactContext,
): Promise<GoalArtifact | undefined> {
    if (!context.branchName) return undefined;
    const [owner, repo] = context.repository.split('/');
    let base = context.baseBranch;
    if (!base) {
        const repository = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        base = repository.data.default_branch;
    }
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'open',
        head: `${owner}:${context.branchName}`,
        base,
        per_page: 100,
    });
    const pull = response.data.find(candidate =>
        candidate.head.ref === context.branchName
        && candidate.base.ref === base
        && candidate.draft === true
        && candidate.merged_at == null);
    return pull ? {
        type: 'pull_request',
        number: pull.number,
        url: pull.html_url,
        state: pull.state,
        draft: true,
    } : undefined;
}

function artifactStats(artifacts: GoalArtifact[]): GoalArtifactStats {
    const issues = artifacts.filter(artifact => artifact.type === 'issue');
    const pullRequests = artifacts.filter(artifact => artifact.type === 'pull_request');
    return {
        issues: issues.length,
        openIssues: issues.filter(artifact => artifact.state === 'open').length,
        pullRequests: pullRequests.length,
        openPullRequests: pullRequests.filter(artifact => artifact.state === 'open').length,
    };
}

export async function validateGoalArtifacts(options: {
    context: GoalArtifactContext;
    existing: GoalArtifact[];
    output: string;
    octokit?: Octokit;
}): Promise<{ artifacts: GoalArtifact[]; stats: GoalArtifactStats; finalPr?: GoalArtifact }> {
    const octokit = options.octokit ?? await getAuthenticatedOctokit();
    const [owner, repo] = options.context.repository.split('/');
    const candidates = new Map<string, GoalArtifact>();
    for (const artifact of [...options.existing, ...discoverRepositoryArtifacts(options.context.repository, options.output)]) {
        if (!isRepositoryArtifact(options.context.repository, artifact)) continue;
        candidates.set(`${artifact.type}:${artifact.number}`, artifact);
    }
    const validated = (await Promise.all(
        [...candidates.values()].map(artifact => validateArtifact(octokit, owner, repo, artifact)),
    )).filter((artifact): artifact is GoalArtifact => artifact !== null);
    const finalPr = await findExpectedFinalPr(octokit, options.context);
    if (finalPr) {
        const key = `pull_request:${finalPr.number}`;
        const index = validated.findIndex(artifact => `${artifact.type}:${artifact.number}` === key);
        if (index >= 0) validated[index] = finalPr;
        else validated.push(finalPr);
    }
    return { artifacts: validated, stats: artifactStats(validated), finalPr };
}
