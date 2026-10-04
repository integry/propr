#!/usr/bin/env node
/**
 * Decides whether a pull request run should overflow its Linux checks from
 * GitHub-hosted runners to the rootless self-hosted pool.
 *
 * Used only when `PROPR_ROOTLESS_PR_CHECKS=overflow` (see docs/ci-runners.md).
 * GitHub cannot fall back between runner types once a job is queued, so the
 * decision is taken once, before the routed jobs start: overflow when a hosted
 * Linux job has already been waiting for a runner, or when this run's hosted
 * jobs would take the account past its concurrency limit minus a reserve for
 * other repositories and the macOS/Windows desktop jobs.
 *
 * The script never fails the job. Any error, missing token or unexpected
 * response keeps the checks hosted, which is the route every eligible job
 * already supports.
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// GitHub Pro allows 40 concurrent standard hosted jobs.
export const DEFAULT_HOSTED_JOB_LIMIT = 40;
export const DEFAULT_RESERVE = 6;
export const DEFAULT_STALL_SECONDS = 60;
const MAX_RUNS_INSPECTED = 25;
const WAITING_FOR_RUNNER = new Set(['queued', 'pending']);

const isSelfHosted = job => (job.labels ?? []).includes('self-hosted');
// macOS has its own, lower concurrency limit; a queued macOS job says nothing
// about Linux capacity, although running ones count towards the total.
const isMacOS = job => (job.labels ?? []).some(label => /^macos/i.test(label));

/**
 * @param {object} input
 * @param {Array<{status: string, labels?: string[], created_at?: string}>} input.jobs  Jobs of in-progress and queued runs.
 * @param {number} input.now          Epoch milliseconds.
 * @param {number} input.planned      Hosted jobs this run would add.
 */
export function decideOverflow({
    jobs,
    now,
    planned,
    limit = DEFAULT_HOSTED_JOB_LIMIT,
    reserve = DEFAULT_RESERVE,
    stallSeconds = DEFAULT_STALL_SECONDS,
}) {
    const hosted = jobs.filter(job => !isSelfHosted(job));
    const running = hosted.filter(job => job.status === 'in_progress').length;
    const stalled = hosted.filter(job =>
        WAITING_FOR_RUNNER.has(job.status)
        && !isMacOS(job)
        && Number.isFinite(Date.parse(job.created_at ?? ''))
        && now - Date.parse(job.created_at) >= stallSeconds * 1000).length;
    const capacity = Math.max(0, limit - reserve);
    let reason;
    if (stalled > 0) reason = `${stalled} hosted Linux job(s) waited ${stallSeconds}s or more for a runner`;
    else if (running + planned > capacity) reason = `${running} running + ${planned} planned hosted jobs exceed ${capacity} (limit ${limit} - reserve ${reserve})`;
    return { overflow: Boolean(reason), running, stalled, planned, capacity, reason: reason ?? `${running} running + ${planned} planned hosted jobs fit within ${capacity}` };
}

const positiveInteger = (value, fallback) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

async function listActiveJobs({ api, repository, token }) {
    const request = async path => {
        const response = await fetch(`${api}/repos/${repository}${path}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
        return response.json();
    };
    const runs = [];
    for (const status of ['in_progress', 'queued']) {
        runs.push(...(await request(`/actions/runs?status=${status}&per_page=50`)).workflow_runs);
    }
    runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const jobs = [];
    for (const run of runs.slice(0, MAX_RUNS_INSPECTED)) {
        jobs.push(...(await request(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs);
    }
    return jobs;
}

async function main(env = process.env) {
    const planned = positiveInteger(env.PROPR_PLANNED_HOSTED_JOBS, 1);
    const limit = positiveInteger(env.PROPR_HOSTED_JOB_LIMIT, DEFAULT_HOSTED_JOB_LIMIT);
    let decision;
    try {
        if (!env.GH_TOKEN || !env.GITHUB_REPOSITORY) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required');
        const jobs = await listActiveJobs({ api: env.GITHUB_API_URL || 'https://api.github.com', repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN });
        decision = decideOverflow({ jobs, now: Date.now(), planned, limit });
    } catch (error) {
        console.log(`::warning::Hosted capacity check failed, keeping checks hosted: ${error.message}`);
        decision = { overflow: false, reason: `capacity check failed (${error.message})` };
    }
    const route = decision.overflow ? 'rootless self-hosted pool' : 'GitHub-hosted runners';
    console.log(`Routing to ${route}: ${decision.reason}`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `overflow=${decision.overflow}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### PR check runner\n\n${route}: ${decision.reason}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
