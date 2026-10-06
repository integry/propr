import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  NIGHTLY_HEALTH_LABEL,
  NIGHTLY_HEALTH_TITLE,
  assertIntakeSafeLabels,
  collectFailures,
  extractFailingStepLog,
  findHealthIssue,
  formatFailureReport,
  nightlyOutcome,
  reconcileNightlyHealth,
  runNightlyHealth,
  summarizeLog,
} from "../scripts/nightly-health-issue.mjs";

const OWNER = "integry";
const REPO = "propr";
const RUN_URL = "https://github.com/integry/propr/actions/runs/42";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const healthIssue = (number, overrides = {}) => ({
  number,
  title: NIGHTLY_HEALTH_TITLE,
  state: "open",
  labels: [{ name: NIGHTLY_HEALTH_LABEL }],
  ...overrides,
});

function fakeGitHub({ issues = [], labelExists = true, jobs = [], jobLogs = {}, defaultBranch = "main" } = {}) {
  const calls = [];
  const record = (name, result) => async (params) => {
    calls.push({ name, params });
    return typeof result === "function" ? result(params) : result;
  };
  const github = {
    calls,
    paginate: async (method, params) => (await method(params)).data,
    rest: {
      repos: { get: record("repos.get", { data: { default_branch: defaultBranch } }) },
      issues: {
        getLabel: record("getLabel", () => {
          if (labelExists) return { data: { name: NIGHTLY_HEALTH_LABEL } };
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }),
        createLabel: record("createLabel", { data: {} }),
        listForRepo: record("listForRepo", (params) => ({
          data: issues.filter((issue) => issue.state === params.state
            && issue.labels.some((label) => (label.name ?? label) === params.labels)),
        })),
        create: record("create", { data: { number: 900 } }),
        createComment: record("createComment", { data: {} }),
        update: record("update", { data: {} }),
      },
      actions: {
        listJobsForWorkflowRunAttempt: record("listJobs", { data: jobs }),
        downloadJobLogsForWorkflowRun: record("downloadJobLogs", ({ job_id }) => {
          if (!(job_id in jobLogs)) throw Object.assign(new Error("Gone"), { status: 410 });
          return { data: jobLogs[job_id] };
        }),
      },
    },
  };
  return github;
}

const writes = (github) => github.calls.filter(({ name }) => ["create", "createComment", "update", "createLabel"].includes(name));

describe("nightly health issue", () => {
  it("finds only the open, labelled issue with the exact title and prefers the oldest", () => {
    const issues = [
      healthIssue(12),
      healthIssue(7),
      healthIssue(3, { title: "Nightly test health (old)" }),
      healthIssue(2, { labels: [{ name: "bug" }] }),
      healthIssue(1, { pull_request: {} }),
      healthIssue(4, { state: "closed" }),
    ];
    assert.equal(findHealthIssue(issues).number, 7);
    assert.equal(findHealthIssue([healthIssue(5, { labels: [NIGHTLY_HEALTH_LABEL] })]).number, 5);
    assert.equal(findHealthIssue([]), null);
  });

  it("opens the issue with only the nightly-health label, creating the label when missing", async () => {
    const github = fakeGitHub({ labelExists: false });
    const result = await reconcileNightlyHealth({
      github, owner: OWNER, repo: REPO, outcome: "failure", runUrl: RUN_URL, sha: SHA,
      failures: [{ job: "Run E2E Test Suite", steps: ["Fail Job"], excerpt: "1/3 test runs failed after 2.0s:\n- test/a.test.ts: exit 1" }],
    });
    assert.deepEqual(result, { action: "created", number: 900 });
    const created = github.calls.find(({ name }) => name === "createLabel");
    assert.equal(created.params.name, NIGHTLY_HEALTH_LABEL);
    const issue = github.calls.find(({ name }) => name === "create").params;
    assert.equal(issue.title, NIGHTLY_HEALTH_TITLE);
    assert.deepEqual(issue.labels, [NIGHTLY_HEALTH_LABEL]);
    assert.ok(!issue.labels.some((label) => label === "AI" || label.startsWith("llm-")), "never a ProPR trigger label");
    for (const expected of [RUN_URL, SHA, "- Run E2E Test Suite (Fail Job)", "- test/a.test.ts: exit 1"]) {
      assert.ok(issue.body.includes(expected), `body includes ${expected}`);
    }
  });

  it("comments on the open issue instead of opening a duplicate", async () => {
    const github = fakeGitHub({ issues: [healthIssue(31), healthIssue(44)] });
    const result = await reconcileNightlyHealth({
      github, owner: OWNER, repo: REPO, outcome: "failure", runUrl: RUN_URL, sha: SHA, failures: [],
    });
    assert.deepEqual(result, { action: "commented", number: 31 });
    assert.deepEqual(writes(github).map(({ name }) => name), ["createComment"]);
    assert.match(github.calls.find(({ name }) => name === "createComment").params.body, /could not be identified/);
  });

  it("comments green and closes the open issue on success", async () => {
    const github = fakeGitHub({ issues: [healthIssue(31)] });
    const result = await reconcileNightlyHealth({ github, owner: OWNER, repo: REPO, outcome: "success", runUrl: RUN_URL, sha: SHA });
    assert.deepEqual(result, { action: "closed", number: 31 });
    const [comment, close] = writes(github);
    assert.equal(comment.params.body, `Green on ${SHA} — ${RUN_URL}`);
    assert.deepEqual(close.params, { owner: OWNER, repo: REPO, issue_number: 31, state: "closed", state_reason: "completed" });
  });

  it("does nothing on success without an open issue, or when the outcome is inconclusive", async () => {
    for (const [outcome, issues] of [["success", []], ["unknown", [healthIssue(31)]]]) {
      const github = fakeGitHub({ issues });
      const result = await reconcileNightlyHealth({ github, owner: OWNER, repo: REPO, outcome, runUrl: RUN_URL, sha: SHA });
      assert.deepEqual(result, { action: "none" });
      assert.deepEqual(writes(github), []);
    }
  });

  it("derives the night's outcome from the upstream job results", () => {
    assert.equal(nightlyOutcome({ a: { result: "success" }, b: { result: "success" } }), "success");
    assert.equal(nightlyOutcome({ a: { result: "success" }, b: { result: "failure" } }), "failure");
    assert.equal(nightlyOutcome({ a: { result: "skipped" }, b: { result: "failure" } }), "failure");
    assert.equal(nightlyOutcome({ a: { result: "success" }, b: { result: "skipped" } }), "unknown");
    assert.equal(nightlyOutcome({ a: { result: "cancelled" } }), "unknown");
    assert.equal(nightlyOutcome({}), "unknown");
  });

  it("refuses ProPR trigger labels", () => {
    assert.deepEqual(assertIntakeSafeLabels([NIGHTLY_HEALTH_LABEL, "bug"]), [NIGHTLY_HEALTH_LABEL, "bug"]);
    for (const label of ["AI", "ai", "llm-claude", "LLM-codex"]) {
      assert.throws(() => assertIntakeSafeLabels([label]), /trigger label/);
    }
  });

  it("prefers the test runner's failure summary and caps excerpts at 60 lines", () => {
    const noisy = [...Array.from({ length: 100 }, (_, index) => `line ${index}`), "2/9 test runs failed after 3.0s:", "- test/a.test.ts: exit 1", "- test/b.test.ts: timed out", ""].join("\n");
    assert.equal(summarizeLog(noisy), "2/9 test runs failed after 3.0s:\n- test/a.test.ts: exit 1\n- test/b.test.ts: timed out");
    const plain = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const excerpt = summarizeLog(plain).split("\n");
    assert.equal(excerpt.length, 61);
    assert.equal(excerpt[0], "line 0");
    assert.equal(excerpt[59], "line 59");
    assert.match(excerpt[60], /40 more lines/);
  });

  it("extracts the failing step from a timestamped job log", () => {
    const log = [
      "2026-10-06T02:00:00.0000000Z ##[group]Run npm ci",
      "2026-10-06T02:00:00.0000000Z npm ci",
      "2026-10-06T02:00:00.0000000Z ##[endgroup]",
      "2026-10-06T02:00:01.0000000Z added 1 package",
      "2026-10-06T02:00:02.0000000Z ##[group]Run node scripts/run-test-suite.mjs",
      "2026-10-06T02:00:02.0000000Z node scripts/run-test-suite.mjs",
      "2026-10-06T02:00:02.0000000Z shell: /usr/bin/bash -e {0}",
      "2026-10-06T02:00:02.0000000Z ##[endgroup]",
      "2026-10-06T02:00:03.0000000Z not ok 1 - renders",
      "2026-10-06T02:00:04.0000000Z ##[error]Process completed with exit code 1.",
      "2026-10-06T02:00:05.0000000Z ##[group]Run actions/upload-artifact@v6",
      "2026-10-06T02:00:05.0000000Z uploaded",
    ].join("\n");
    assert.equal(extractFailingStepLog(log), "not ok 1 - renders\n##[error]Process completed with exit code 1.");
  });

  it("collects failed jobs with the suite artifact excerpt or the job log", async () => {
    const diagnostics = mkdtempSync(join(tmpdir(), "nightly-health-"));
    try {
      writeFileSync(join(diagnostics, "test_output.sanitized.txt"), "start\n1/2 test runs failed after 1.0s:\n- test/x.test.ts: exit 1\n");
      writeFileSync(join(diagnostics, "e2e_output.sanitized.txt"), "Test output file not available.");
      const github = fakeGitHub({
        jobs: [
          { id: 1, name: "Run E2E Test Suite", conclusion: "failure", steps: [{ name: "Install Dependencies", conclusion: "success" }, { name: "Fail Job", conclusion: "failure" }] },
          { id: 2, name: "Nightly Native Electron (hosted)", conclusion: "timed_out", steps: [] },
          { id: 3, name: "Nightly desktop package / validate", conclusion: "failure", steps: [] },
          { id: 4, name: "Nightly Packaged Connect / connect", conclusion: "success", steps: [] },
          { id: 5, name: "Nightly test health", conclusion: null, steps: [] },
        ],
        jobLogs: { 2: "##[group]Run x\nx\n##[endgroup]\nboom\n##[error]exit 1" },
      });
      const messages = [];
      const failures = await collectFailures({
        github, owner: OWNER, repo: REPO, runId: 42, runAttempt: 2, diagnosticsDir: diagnostics,
        suiteJobName: "Run E2E Test Suite", currentJobName: "Nightly test health", log: (message) => messages.push(message),
      });
      assert.deepEqual(failures, [
        { job: "Run E2E Test Suite", steps: ["Fail Job"], excerpt: "1/2 test runs failed after 1.0s:\n- test/x.test.ts: exit 1" },
        { job: "Nightly Native Electron (hosted)", steps: [], excerpt: "boom\n##[error]exit 1" },
        { job: "Nightly desktop package / validate", steps: [], excerpt: "" },
      ]);
      assert.equal(github.calls.find(({ name }) => name === "listJobs").params.attempt_number, 2);
      assert.match(messages[0], /Could not read the log of Nightly desktop package/);
    } finally {
      rmSync(diagnostics, { recursive: true, force: true });
    }
  });

  it("redacts credentials and keeps the report within GitHub's body limit", () => {
    const body = formatFailureReport({
      runUrl: RUN_URL,
      sha: SHA,
      failures: Array.from({ length: 4 }, (_, index) => ({
        job: `job ${index}`,
        steps: [],
        excerpt: `token ghp_abcdefghijklmnopqrstuvwxyz123456\n${"x".repeat(399)}\n`.repeat(200),
      })),
    });
    assert.ok(body.length < 65536);
    assert.ok(!body.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"));
    assert.equal(body.match(/^~~~text$/gm).length, body.match(/^~~~$/gm).length, "every excerpt fence is closed");
  });

  it("leaves the issue alone for runs on other refs", async () => {
    const github = fakeGitHub({ issues: [healthIssue(31)] });
    const result = await runNightlyHealth({
      github,
      context: { repo: { owner: OWNER, repo: REPO }, ref: "refs/heads/feature", runId: 42, sha: SHA, serverUrl: "https://github.com" },
      core: { info() {} },
      env: { NEEDS_JSON: JSON.stringify({ a: { result: "success" } }) },
    });
    assert.deepEqual(result, { action: "none" });
    assert.deepEqual(writes(github), []);
  });

  it("closes the issue for a green run on the default branch", async () => {
    const github = fakeGitHub({ issues: [healthIssue(31)] });
    const result = await runNightlyHealth({
      github,
      context: { repo: { owner: OWNER, repo: REPO }, ref: "refs/heads/main", runId: 42, sha: SHA, serverUrl: "https://github.com" },
      core: { info() {} },
      env: { NEEDS_JSON: JSON.stringify({ a: { result: "success" }, b: { result: "success" } }) },
    });
    assert.deepEqual(result, { action: "closed", number: 31 });
    assert.equal(github.calls.find(({ name }) => name === "createComment").params.body, `Green on ${SHA} — ${RUN_URL}`);
  });

  it("is wired into the nightly workflow as a final job with issue write access", () => {
    const workflow = readFileSync(new URL("../.github/workflows/test-nightly.yml", import.meta.url), "utf8");
    const job = workflow.slice(workflow.indexOf("\n  nightly-health:\n"));
    assert.match(job, /needs: \[e2e-tests, native-electron, desktop-package, desktop-connect\]/);
    assert.match(job, /if: \$\{\{ !cancelled\(\) \}\}/);
    assert.match(job, /permissions:\n\s+contents: read\n\s+actions: read\n\s+issues: write\n/);
    assert.match(job, /NIGHTLY_SUITE_JOB_NAME: Run E2E Test Suite\n/);
    assert.match(workflow, /\n {4}name: Run E2E Test Suite\n/, "the suite job name matches");
    assert.match(job, /NIGHTLY_HEALTH_JOB_NAME: Nightly test health\n/);
    assert.match(job, /\n {4}name: Nightly test health\n/);
    assert.match(job, /scripts\/nightly-health-issue\.mjs/);
    assert.doesNotMatch(workflow, /nightly-test-failure/, "the per-day failure issue is replaced");
  });
});
