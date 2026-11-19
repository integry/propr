/**
 * Proves, per workflow run, that a failed GitHub Actions job is only an
 * aggregate of other failed jobs of the same run (such as `Run Full Test
 * Suite` failing because `Full Test Suite Shard 3/4` failed), so the CI-failure
 * comment can list the needed job as the failure and mention the aggregate
 * once, as its consequence.
 *
 * Nothing is guessed from names. A job is folded only when all of this holds:
 *  - the workflow file at the run's head commit parses, the failed job's name
 *    maps to exactly one job id of it, and that job `needs` at least one job
 *    that failed in this run attempt (a failed job counts only when its name
 *    maps to exactly one job id; matrix jobs map through their expanded name);
 *  - every step of the failed job that did not pass is a gate step: a named
 *    step of that job whose definition reads `needs.<id>.result` of one of the
 *    failed needed jobs, and whose name no other step of the job shares.
 * A job with no failed step, an unreadable or unparsable workflow file, an
 * incomplete job listing or any ambiguous mapping is not folded: it is listed
 * as a failure of its own.
 */
import { parse as parseYaml } from 'yaml';
import type logger from '../utils/logger.js';

type Log = ReturnType<typeof logger.withCorrelation>;

export interface WorkflowStep {
    name?: string;
    /** The step's definition other than its name (`run`, `env`, `if`, `with`, …), as text. */
    definition: string;
}

export interface WorkflowJob {
    id: string;
    name?: string;
    needs: string[];
    matrix: boolean;
    /** Calls a reusable workflow; GitHub names its jobs `<caller> / <called>`. */
    reusable: boolean;
    steps: WorkflowStep[];
}

export interface ParsedWorkflow {
    jobs: WorkflowJob[];
}

export interface RunJob {
    id: number;
    name: string;
    conclusion: string | null;
    url?: string;
}

export interface JobStep {
    name: string;
    conclusion: string | null;
}

export interface AggregateFold {
    /** The aggregate's job name as GitHub reports it. */
    aggregate: string;
    /** The failed jobs it needs, which made it fail. */
    causes: RunJob[];
}

export interface AggregateFoldGitHub {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
}

/** Workflow files by run id, for the comment being built. */
export type WorkflowCache = Map<number, Promise<ParsedWorkflow | null>>;

const ACTIONS_JOB_URL_RE = /\/actions\/runs\/(\d+)\/job\/(\d+)/u;
const EXPRESSION_RE = /\$\{\{[\s\S]*?\}\}/u;
const FAILED_JOB_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const PASSING_STEP_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
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
    const rawSteps = job.steps === undefined ? [] : job.steps;
    if (!Array.isArray(rawSteps)) return null;
    const steps: WorkflowStep[] = [];
    for (const rawStep of rawSteps) {
        const step = asRecord(rawStep);
        if (!step) return null;
        const { name, ...definition } = step;
        steps.push({ name: typeof name === 'string' ? name : undefined, definition: JSON.stringify(definition) });
    }
    return {
        id,
        name: job.name as string | undefined,
        needs: needs.map(need => need.toLowerCase()),
        matrix: asRecord(job.strategy)?.matrix !== undefined,
        reusable: typeof job.uses === 'string',
        steps,
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
 * Whether the failed `aggregate` job only reports needed jobs that failed in
 * this run. Pure: `runJobs` is the run attempt's full job listing, `steps` the
 * aggregate job's steps, `workflow` the parsed workflow file at the run's head.
 */
export function decideAggregateFold(
    { aggregate, steps, runJobs, workflow }: {
        aggregate: { id: number; name: string };
        steps: JobStep[];
        runJobs: RunJob[];
        workflow: ParsedWorkflow;
    },
): AggregateFold | null {
    const [aggregateId, ...otherIds] = jobIdsForName(aggregate.name, workflow);
    if (!aggregateId || otherIds.length > 0) return null;
    const job = workflow.jobs.find(entry => entry.id.toLowerCase() === aggregateId);
    if (!job || job.needs.length === 0) return null;

    const causes: RunJob[] = [];
    const causeIds = new Set<string>();
    for (const runJob of runJobs) {
        if (runJob.id === aggregate.id || !FAILED_JOB_CONCLUSIONS.has((runJob.conclusion ?? '').toLowerCase())) continue;
        const ids = jobIdsForName(runJob.name, workflow);
        if (ids.length !== 1 || !job.needs.includes(ids[0])) continue;
        causes.push(runJob);
        causeIds.add(ids[0]);
    }
    if (causes.length === 0) return null;
    return onlyGateStepsFailed(job, steps, causeIds) ? { aggregate: aggregate.name, causes } : null;
}

function onlyGateStepsFailed(job: WorkflowJob, steps: JobStep[], causeIds: Set<string>): boolean {
    const gateNames = new Set(job.steps
        .filter(step => step.name !== undefined && !EXPRESSION_RE.test(step.name) && readsNeededResult(step.definition, causeIds))
        .map(step => step.name as string));
    for (const name of gateNames) {
        if (job.steps.filter(step => step.name === name).length !== 1) gateNames.delete(name);
    }
    const failed = steps.filter(step => !PASSING_STEP_CONCLUSIONS.has((step.conclusion ?? '').toLowerCase()));
    return failed.length > 0 && failed.every(step => gateNames.has(step.name));
}

function readsNeededResult(definition: string, causeIds: Set<string>): boolean {
    const references = definition.matchAll(/needs\.([A-Za-z0-9_-]+)\.result\b/gu);
    return [...references].some(match => causeIds.has(match[1].toLowerCase()));
}

/**
 * Reads what `decideAggregateFold` needs for one failed check run from GitHub:
 * the job and its steps, the attempt's job listing, and the workflow file at
 * the run's head commit (once per run, through `cache`). Never throws: any
 * read failure or doubt is null, and the job is listed on its own.
 */
export async function loadAggregateFold(
    github: AggregateFoldGitHub,
    target: { owner: string; repo: string; url: string; state: string },
    cache: WorkflowCache,
    log: Log,
): Promise<AggregateFold | null> {
    const match = ACTIONS_JOB_URL_RE.exec(target.url);
    if (!match || target.state !== 'failure') return null;
    try {
        const job = asRecord((await github.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', {
            owner: target.owner, repo: target.repo, job_id: Number(match[2]),
        })).data);
        if (!job || typeof job.id !== 'number' || typeof job.name !== 'string' || typeof job.run_attempt !== 'number') return null;
        const steps = readSteps(job.steps);
        if (!steps) return null;
        const runId = typeof job.run_id === 'number' ? job.run_id : Number(match[1]);
        const runJobs = await listRunJobs(github, target, runId, job.run_attempt);
        // Nothing else failed: there is nothing to fold under, and no file to read.
        if (!runJobs?.some(entry => entry.id !== job.id && FAILED_JOB_CONCLUSIONS.has((entry.conclusion ?? '').toLowerCase()))) return null;
        const workflow = await cachedWorkflow(github, target, runId, cache);
        if (!workflow) return null;
        return decideAggregateFold({ aggregate: { id: job.id, name: job.name }, steps, runJobs, workflow });
    } catch (error) {
        log.debug({ url: target.url, error: (error as Error).message }, 'Could not prove a failed job is an aggregate; listing it on its own');
        return null;
    }
}

function readSteps(value: unknown): JobStep[] | null {
    if (!Array.isArray(value)) return null;
    const steps: JobStep[] = [];
    for (const entry of value) {
        const step = asRecord(entry);
        if (!step || typeof step.name !== 'string') return null;
        steps.push({ name: step.name, conclusion: typeof step.conclusion === 'string' ? step.conclusion : null });
    }
    return steps;
}

async function listRunJobs(
    github: AggregateFoldGitHub,
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
        runJobs.push({
            id: job.id,
            name: job.name,
            conclusion: typeof job.conclusion === 'string' ? job.conclusion : null,
            url: typeof job.html_url === 'string' ? job.html_url : undefined,
        });
    }
    return runJobs;
}

function cachedWorkflow(
    github: AggregateFoldGitHub,
    target: { owner: string; repo: string },
    runId: number,
    cache: WorkflowCache,
): Promise<ParsedWorkflow | null> {
    let workflow = cache.get(runId);
    if (!workflow) {
        workflow = loadWorkflow(github, target, runId);
        cache.set(runId, workflow);
    }
    return workflow;
}

/** The run's workflow file at its head commit; throws when unreadable. */
async function loadWorkflow(
    github: AggregateFoldGitHub,
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
