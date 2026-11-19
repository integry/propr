/**
 * Relates a failed GitHub Actions job to the jobs it `needs` that also failed
 * in the same workflow run attempt (such as `Run Full Test Suite` needing the
 * failed `Full Test Suite Shard 3/4`), so the CI-failure comment can say that
 * the job may have failed only because of them and list it after them.
 *
 * This only relates jobs; it never drops a job or its evidence, and it never
 * reads what a job's steps do. Only `jobs.<id>.name`, `jobs.<id>.needs`,
 * `jobs.<id>.strategy.matrix` and `jobs.<id>.uses` of the workflow file at the
 * run's head commit are read. Nothing is guessed from names: when the file
 * cannot be read or parsed, the job listing is incomplete, or a failed job's
 * name does not map to exactly one job id (as can happen with matrix names),
 * the result is null and the comment carries no dependency line.
 */
import { parse as parseYaml } from 'yaml';
import type logger from '../utils/logger.js';

type Log = ReturnType<typeof logger.withCorrelation>;

export interface WorkflowJob {
    id: string;
    name?: string;
    needs: string[];
    matrix: boolean;
    /** Calls a reusable workflow; GitHub names its jobs `<caller> / <called>`. */
    reusable: boolean;
}

export interface ParsedWorkflow {
    jobs: WorkflowJob[];
}

export interface RunJob {
    id: number;
    name: string;
    conclusion: string | null;
}

export interface FailedJobDependencies {
    /** The failed job's name as GitHub reports it. */
    job: string;
    /** The names of the failed jobs it directly needs, in the run's job order. */
    dependsOn: string[];
}

export interface JobDependenciesGitHub {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
}

const ACTIONS_JOB_URL_RE = /\/actions\/runs\/(\d+)\/job\/(\d+)/u;
const FAILED_JOB_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const JOBS_PAGE_SIZE = 100;

/** The workflow's jobs, or null when the text is not a workflow this module can read with certainty. */
export function parseWorkflowJobs(text: string): ParsedWorkflow | null {
    let document: unknown;
    try {
        document = parseYaml(text);
    } catch {
        return null;
    }
    const jobs = asRecord(asRecord(document)?.jobs);
    if (!jobs) return null;
    const parsed: WorkflowJob[] = [];
    for (const [id, value] of Object.entries(jobs)) {
        const job = parseJob(id, value);
        if (!job) return null;
        parsed.push(job);
    }
    return { jobs: parsed };
}

function parseJob(id: string, value: unknown): WorkflowJob | null {
    const job = asRecord(value);
    if (!job) return null;
    const needs = job.needs === undefined ? [] : typeof job.needs === 'string' ? [job.needs] : job.needs;
    if (!Array.isArray(needs) || !needs.every(need => typeof need === 'string')) return null;
    if (job.name !== undefined && typeof job.name !== 'string') return null;
    return {
        id,
        name: job.name as string | undefined,
        needs: needs.map(need => need.toLowerCase()),
        matrix: asRecord(job.strategy)?.matrix !== undefined,
        reusable: typeof job.uses === 'string',
    };
}

/** The ids of the workflow jobs a reported job name can belong to. */
function jobIdsForName(name: string, workflow: ParsedWorkflow): string[] {
    return workflow.jobs.filter(job => nameMatcher(job).test(name)).map(job => job.id.toLowerCase());
}

function nameMatcher(job: WorkflowJob): RegExp {
    const base = job.name ?? job.id;
    let pattern = base.split(/\$\{\{[\s\S]*?\}\}/gu).map(escapeRegExp).join('.*');
    // GitHub appends the matrix values to a matrix job's name that does not use them.
    if (job.matrix) pattern += '(?: \\(.+\\))?';
    if (job.reusable) pattern += ' / .+';
    return new RegExp(`^${pattern}$`, 'u');
}

/**
 * The failed jobs `failed` directly needs, among `runJobs` (the run attempt's
 * full job listing). Pure. Null when there are none, or when the answer is not
 * certain: `failed` or another failed job that may be needed does not map to
 * exactly one job id of `workflow`.
 */
export function relateFailedJob(
    { failed, runJobs, workflow }: { failed: { id: number; name: string }; runJobs: RunJob[]; workflow: ParsedWorkflow },
): FailedJobDependencies | null {
    const [jobId, ...otherIds] = jobIdsForName(failed.name, workflow);
    if (!jobId || otherIds.length > 0) return null;
    const job = workflow.jobs.find(entry => entry.id.toLowerCase() === jobId);
    if (!job || job.needs.length === 0) return null;

    const dependsOn: string[] = [];
    for (const runJob of runJobs) {
        if (runJob.id === failed.id || !isFailedJob(runJob)) continue;
        const ids = jobIdsForName(runJob.name, workflow);
        // A failed job that maps to no id, or to several ids of which one is needed, is a doubt.
        if (ids.length === 0) return null;
        if (!ids.some(id => job.needs.includes(id))) continue;
        if (ids.length > 1) return null;
        dependsOn.push(runJob.name);
    }
    return dependsOn.length > 0 ? { job: failed.name, dependsOn } : null;
}

/**
 * Reads what `relateFailedJob` needs for one failed check run from GitHub: the
 * job, the attempt's job listing and, only when another job of the attempt
 * failed, the workflow file at the run's head commit. Never throws: any read
 * failure or doubt is null, and the comment carries no dependency line.
 */
export async function loadFailedJobDependencies(
    github: JobDependenciesGitHub,
    target: { owner: string; repo: string; url: string },
    log: Log,
): Promise<FailedJobDependencies | null> {
    const match = ACTIONS_JOB_URL_RE.exec(target.url);
    if (!match) return null;
    try {
        const job = asRecord((await github.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', {
            owner: target.owner, repo: target.repo, job_id: Number(match[2]),
        })).data);
        if (!job || typeof job.id !== 'number' || typeof job.name !== 'string' || typeof job.run_attempt !== 'number') return null;
        const runId = typeof job.run_id === 'number' ? job.run_id : Number(match[1]);
        const runJobs = await listRunJobs(github, target, runId, job.run_attempt);
        if (!runJobs?.some(entry => entry.id !== job.id && isFailedJob(entry))) return null;
        const workflow = await loadWorkflow(github, target, runId);
        if (!workflow) return null;
        return relateFailedJob({ failed: { id: job.id, name: job.name }, runJobs, workflow });
    } catch (error) {
        log.debug({ url: target.url, error: (error as Error).message }, 'Could not relate a failed job to the jobs it needs; adding no dependency line');
        return null;
    }
}

function isFailedJob(job: RunJob): boolean {
    return FAILED_JOB_CONCLUSIONS.has((job.conclusion ?? '').toLowerCase());
}

async function listRunJobs(
    github: JobDependenciesGitHub,
    target: { owner: string; repo: string },
    runId: number,
    attempt: number,
): Promise<RunJob[] | null> {
    const { data } = await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
        owner: target.owner, repo: target.repo, run_id: runId, attempt_number: attempt, per_page: JOBS_PAGE_SIZE,
    });
    const listing = asRecord(data);
    const jobs = Array.isArray(listing?.jobs) ? listing.jobs.map(asRecord) : [];
    if (typeof listing?.total_count !== 'number' || listing.total_count > jobs.length) return null;
    const runJobs: RunJob[] = [];
    for (const job of jobs) {
        if (!job || typeof job.id !== 'number' || typeof job.name !== 'string') return null;
        runJobs.push({ id: job.id, name: job.name, conclusion: typeof job.conclusion === 'string' ? job.conclusion : null });
    }
    return runJobs;
}

/** The run's workflow file at its head commit; throws when unreadable. */
async function loadWorkflow(
    github: JobDependenciesGitHub,
    target: { owner: string; repo: string },
    runId: number,
): Promise<ParsedWorkflow | null> {
    const run = asRecord((await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
        owner: target.owner, repo: target.repo, run_id: runId,
    })).data);
    if (typeof run?.path !== 'string' || typeof run.head_sha !== 'string') return null;
    // A reusable or dynamic workflow's path can carry `@<ref>`; only a plain file at the head is read.
    if (run.path.includes('@') || !run.path.startsWith('.github/workflows/')) return null;
    const file = asRecord((await github.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: target.owner, repo: target.repo, path: run.path, ref: run.head_sha,
    })).data);
    if (file?.encoding !== 'base64' || typeof file.content !== 'string') return null;
    return parseWorkflowJobs(Buffer.from(file.content, 'base64').toString('utf8'));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
