#!/usr/bin/env node

// Keeps one "Nightly test health" issue in step with the nightly workflow:
// a red night opens it (or comments on the open one), the next green night
// comments and closes it. Called from actions/github-script in
// .github/workflows/test-nightly.yml, which passes its authenticated client.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeCiOutput } from "./sanitize-ci-output.mjs";

export const NIGHTLY_HEALTH_TITLE = "Nightly test health";
export const NIGHTLY_HEALTH_LABEL = "nightly-health";
export const EXCERPT_LINES = 60;

const LABEL_COLOR = "d93f0b";
const LABEL_DESCRIPTION = "Tracks the nightly test suite; not an AI task";
const MAX_LINE_LENGTH = 400;
// GitHub rejects issue and comment bodies over 65536 characters.
const MAX_BODY_LENGTH = 60000;
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);

// ProPR only admits issues carrying a configured trigger label (`AI` by
// default, `llm-*` for model selection), so this issue must never carry one.
export function assertIntakeSafeLabels(labels) {
  for (const label of labels) {
    if (label.toLowerCase() === "ai" || /^llm-/i.test(label)) {
      throw new Error(`Refusing to apply ProPR trigger label "${label}" to the nightly health issue`);
    }
  }
  return labels;
}

const labelNames = (issue) => (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));

// The oldest open issue wins, so a stray duplicate never splits the history.
export function findHealthIssue(issues) {
  return issues
    .filter((issue) => !issue.pull_request && issue.state !== "closed")
    .filter((issue) => issue.title === NIGHTLY_HEALTH_TITLE && labelNames(issue).includes(NIGHTLY_HEALTH_LABEL))
    .sort((left, right) => left.number - right.number)[0] ?? null;
}

// Any failed upstream job makes the night red; a skipped or cancelled job
// with no failure is inconclusive and leaves the issue untouched.
export function nightlyOutcome(needs) {
  const results = Object.values(needs ?? {}).map((need) => need?.result);
  if (results.length === 0) return "unknown";
  if (results.includes("failure")) return "failure";
  if (results.every((result) => result === "success")) return "success";
  return "unknown";
}

const stripTimestamp = (line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
const clip = (line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line);

// Prefers the failure summary scripts/run-test-suite.mjs prints last; falls
// back to the first lines of the output.
export function summarizeLog(text, maxLines = EXCERPT_LINES) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n").map(stripTimestamp);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return "";
  const summaryStart = lines.findLastIndex((line) => /^\d+\/\d+ test runs failed\b/.test(line));
  const selected = summaryStart >= 0 ? lines.slice(summaryStart) : lines;
  const excerpt = selected.slice(0, maxLines).map(clip);
  if (selected.length > maxLines) excerpt.push(`… ${selected.length - maxLines} more lines in the run log`);
  return excerpt.join("\n");
}

// A job log is one stream; each step opens with `##[group]Run …`. The failing
// step is the one holding the first `##[error]`, its group header (the echoed
// script and env) is dropped.
export function extractFailingStepLog(jobLog) {
  const lines = String(jobLog ?? "").replace(/\r\n/g, "\n").split("\n").map(stripTimestamp);
  const errorIndex = lines.findIndex((line) => line.startsWith("##[error]"));
  if (errorIndex < 0) return lines.join("\n");
  let start = 0;
  for (let index = errorIndex; index >= 0; index -= 1) {
    if (lines[index].startsWith("##[group]Run ")) {
      start = index;
      break;
    }
  }
  let end = lines.length;
  for (let index = errorIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("##[group]Run ")) {
      end = index;
      break;
    }
  }
  const step = lines.slice(start, end);
  const headerEnd = step[0]?.startsWith("##[group]Run ") ? step.indexOf("##[endgroup]") : -1;
  return step.slice(headerEnd + 1).join("\n");
}

export function formatFailureReport({ runUrl, sha, failures, heading = "Nightly test suite failed" }) {
  const parts = [
    `## ${heading}`,
    "",
    `**Run:** ${runUrl}`,
    `**Commit:** ${sha}`,
    "",
    "**Failing jobs:**",
    ...(failures.length > 0
      ? failures.map((failure) => `- ${failure.job}${failure.steps?.length ? ` (${failure.steps.join(", ")})` : ""}`)
      : ["- The failing job could not be identified; see the run."]),
  ];
  // Each excerpt gets an equal share of the body limit, cut at a line break.
  const budget = Math.max(500, Math.floor(MAX_BODY_LENGTH / Math.max(1, failures.length)) - 1000);
  for (const failure of failures) {
    parts.push("", `### ${failure.job}`, "");
    if (failure.excerpt) {
      let excerpt = sanitizeCiOutput(failure.excerpt);
      if (excerpt.length > budget) {
        excerpt = `${excerpt.slice(0, excerpt.lastIndexOf("\n", budget) + 1 || budget)}… truncated; see the run log`;
      }
      parts.push("~~~text", excerpt, "~~~");
    } else {
      parts.push("_No log excerpt is available; see the run._");
    }
  }
  parts.push("", "Sanitized test output is attached to the run as the `nightly-test-output` artifact when the suite ran.");
  return parts.join("\n");
}

export function formatGreenComment({ sha, runUrl }) {
  return `Green on ${sha} — ${runUrl}`;
}

async function ensureLabel(github, owner, repo) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: NIGHTLY_HEALTH_LABEL });
    return;
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  try {
    await github.rest.issues.createLabel({ owner, repo, name: NIGHTLY_HEALTH_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION });
  } catch (error) {
    // 422: created concurrently.
    if (error?.status !== 422) throw error;
  }
}

async function openHealthIssue(github, owner, repo) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    labels: NIGHTLY_HEALTH_LABEL,
    per_page: 100,
  });
  return findHealthIssue(issues);
}

/**
 * Applies a nightly outcome to the health issue. Returns what it did:
 * `created`, `commented` or `closed` with the issue number, or `none`.
 */
export async function reconcileNightlyHealth({ github, owner, repo, outcome, runUrl, sha, failures = [], log = () => {} }) {
  if (outcome === "failure") {
    await ensureLabel(github, owner, repo);
    const body = formatFailureReport({ runUrl, sha, failures });
    const existing = await openHealthIssue(github, owner, repo);
    if (existing) {
      await github.rest.issues.createComment({ owner, repo, issue_number: existing.number, body });
      log(`Commented on nightly health issue #${existing.number}`);
      return { action: "commented", number: existing.number };
    }
    const { data } = await github.rest.issues.create({
      owner,
      repo,
      title: NIGHTLY_HEALTH_TITLE,
      body,
      labels: assertIntakeSafeLabels([NIGHTLY_HEALTH_LABEL]),
    });
    log(`Opened nightly health issue #${data.number}`);
    return { action: "created", number: data.number };
  }

  if (outcome === "success") {
    const existing = await openHealthIssue(github, owner, repo);
    if (!existing) {
      log("Nightly is green and no health issue is open");
      return { action: "none" };
    }
    await github.rest.issues.createComment({ owner, repo, issue_number: existing.number, body: formatGreenComment({ sha, runUrl }) });
    await github.rest.issues.update({ owner, repo, issue_number: existing.number, state: "closed", state_reason: "completed" });
    log(`Closed nightly health issue #${existing.number}`);
    return { action: "closed", number: existing.number };
  }

  log(`Nightly outcome is ${outcome}; leaving the health issue unchanged`);
  return { action: "none" };
}

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const responseText = (data) => (typeof data === "string" ? data : Buffer.from(data ?? "").toString("utf8"));

// The suite job's test steps continue on error and report their outcomes as
// job outputs; only a failed test step has an output artifact describing it.
// A configuration failure, or any failure after passing tests, is read from
// the job log instead.
const SUITE_STEPS = [
  { output: "full_tests", name: "Run Full Test Suite", artifact: "test_output.sanitized.txt" },
  { output: "e2e_config", name: "Validate live E2E configuration", artifact: null },
  { output: "e2e_tests", name: "Run E2E Tests", artifact: "e2e_output.sanitized.txt" },
];

function suiteArtifactExcerpt(diagnosticsDir, failedSteps) {
  if (!diagnosticsDir || failedSteps.length === 0 || failedSteps.some((step) => !step.artifact)) return "";
  const excerpts = failedSteps.map((step) => readText(join(diagnosticsDir, step.artifact)))
    .map((text) => (text && text.trim() && !text.startsWith("Test output file not available.") ? summarizeLog(text) : ""));
  return excerpts.every(Boolean) ? excerpts.join("\n\n") : "";
}

/**
 * Names the failed jobs and steps of this run attempt with a log excerpt each.
 * The suite job's excerpt comes from the sanitized output artifact of its
 * failed test step; anything else uses the GitHub job log.
 */
export async function collectFailures({ github, owner, repo, runId, runAttempt, diagnosticsDir, suiteJobName, suiteStepOutcomes = {}, currentJobName, log = () => {} }) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    owner,
    repo,
    run_id: runId,
    attempt_number: runAttempt,
    per_page: 100,
  });
  const failures = [];
  for (const job of jobs) {
    if (job.name === currentJobName || !FAILED_CONCLUSIONS.has(job.conclusion)) continue;
    const steps = (job.steps ?? []).filter((step) => FAILED_CONCLUSIONS.has(step.conclusion)).map((step) => step.name);
    let excerpt = "";
    if (job.name === suiteJobName) {
      const failedSteps = SUITE_STEPS.filter((step) => suiteStepOutcomes?.[step.output] === "failure");
      for (const step of [...failedSteps].reverse()) {
        if (!steps.includes(step.name)) steps.unshift(step.name);
      }
      excerpt = suiteArtifactExcerpt(diagnosticsDir, failedSteps);
    }
    if (!excerpt) {
      try {
        const { data } = await github.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: job.id });
        excerpt = summarizeLog(extractFailingStepLog(responseText(data)));
      } catch (error) {
        log(`Could not read the log of ${job.name}: ${error?.message ?? error}`);
      }
    }
    failures.push({ job: job.name, steps, excerpt });
  }
  return failures;
}

// Entry point for the workflow's github-script step.
export async function runNightlyHealth({ github, context, core, env = process.env }) {
  const { owner, repo } = context.repo;
  const log = (message) => core.info(message);
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  if (context.ref !== `refs/heads/${repository.default_branch}`) {
    log(`${context.ref} is not the default branch; leaving the health issue unchanged`);
    return { action: "none" };
  }
  const needs = JSON.parse(env.NEEDS_JSON || "{}");
  const outcome = nightlyOutcome(needs);
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const failures = outcome === "failure"
    ? await collectFailures({
      github,
      owner,
      repo,
      runId: context.runId,
      runAttempt: Number(env.GITHUB_RUN_ATTEMPT) || 1,
      diagnosticsDir: env.NIGHTLY_DIAGNOSTICS_DIR,
      suiteJobName: env.NIGHTLY_SUITE_JOB_NAME,
      suiteStepOutcomes: needs[env.NIGHTLY_SUITE_JOB_ID]?.outputs ?? {},
      currentJobName: env.NIGHTLY_HEALTH_JOB_NAME,
      log,
    })
    : [];
  return reconcileNightlyHealth({ github, owner, repo, outcome, runUrl, sha: context.sha, failures, log });
}
