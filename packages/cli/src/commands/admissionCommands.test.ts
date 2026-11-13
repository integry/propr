import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AgentRunAdmissionReport } from "../api/index.js";
import { ADMISSION_HEADERS, createAdmissionCommand, formatAdmissionReport, formatAdmissionRows } from "./admissionCommands.js";

const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
});

const states = (running: number, reserved = 0, recovering = 0) => ({ reserved, running, draining: 0, recovering, total: running + reserved + recovering });
const waiting = (globalLimit: number, agentCeiling: number) => ({ total: globalLimit + agentCeiling, globalLimit, agentCeiling, recovering: 0, starting: 0 });

function report(): AgentRunAdmissionReport {
  return {
    asOf: "2026-11-13T10:00:00.000Z",
    admission: {
      enabled: true, agentCeilingsConfigured: true,
      global: {
        limit: 3, limitSource: "PROPR_AGENT_RUN_LIMIT", generation: 0, nestedLimit: 4, nestedLimitSource: "default",
        inUse: 3, holders: states(2, 1), unattributedHolders: 0,
        nested: { total: 1, chargedUnderParent: 1, countedAgainstOtherAgent: 0 }, waiting: waiting(1, 2), deferred: 4,
      },
    },
    agents: [
      {
        alias: "cloud", ceiling: null, inUse: 2, holders: states(1, 1), nested: { total: 1, chargedUnderParent: 1, countedAgainstCeiling: 0 },
        waiting: waiting(1, 0), deferred: 0, tasks: [{ taskId: "task-cloud", alias: "cloud", state: "running", nested: false }],
      },
      {
        alias: "local-llama", ceiling: 1, inUse: 1, holders: states(1), nested: { total: 0, chargedUnderParent: 0, countedAgainstCeiling: 0 },
        waiting: waiting(0, 2), deferred: 4, tasks: [{ taskId: "task-local", alias: "local-llama", state: "waiting", waitReason: "alias_limit", nested: false }],
      },
    ],
    queueWorkers: { label: "Queue worker concurrency: …", inUse: 5, total: 5, workers: 1 },
    repositoryWorkflowSlots: { label: "Repository workflow slots: …", repositories: [{ repository: "acme/app", inUse: 2, limit: 2, waiting: 1 }] },
    subscriptionUsage: "Subscription usage is not part of this report.",
  };
}

test("admission rows show the global limit first, then each agent with its ceiling and waits split by reason", () => {
  assert.deepEqual(formatAdmissionRows(report()), [
    ["(global)", "3", "3", "2", "1", "0", "0", "1", "1", "2", "0", "4"],
    ["cloud", "—", "2", "1", "1", "0", "0", "1", "1", "0", "0", "0"],
    ["local-llama", "1", "1", "1", "0", "0", "0", "0", "0", "2", "0", "4"],
  ]);
  assert.equal(ADMISSION_HEADERS.length, 12);
});

test("the readable report labels every limit and lists visible tasks", () => {
  const text = formatAdmissionReport(report()).join("\n");
  assert.match(text, /Global limit 3 \(PROPR_AGENT_RUN_LIMIT\) · generation 0 · nested executions per parent 4 \(default\)/);
  assert.match(text, /^Agent +Ceiling +In use +Running/m);
  assert.match(text, /^local-llama +1 +1 +1 +0 +0 +0 +0 +0 +2 +0 +4$/m);
  assert.match(text, /local-llama {2}waiting \(alias_limit\) {2}task-local/);
  assert.match(text, /Queue workers: 5 of 5 job slots in use across 1 worker\(s\)\./);
  assert.match(text, /acme\/app {2}2\/2 in use, 1 waiting/);
  assert.match(text, /Subscription usage is not part of this report\./);
});

test("with admission off the report says so and still prints the other limits", () => {
  const off: AgentRunAdmissionReport = { ...report(), admission: { enabled: false, agentCeilingsConfigured: false, global: null }, agents: [] };
  assert.deepEqual(formatAdmissionRows(off), []);
  const text = formatAdmissionReport(off).join("\n");
  assert.match(text, /Admission is off/);
  assert.doesNotMatch(text, /^Agent +Ceiling/m);
  assert.match(text, /Queue workers: 5 of 5/);
  assert.match(text, /acme\/app/);
});

async function run(args: string[]): Promise<{ output: string[]; requested: string[] }> {
  const output: string[] = [];
  const requested: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    requested.push(new URL(String(input instanceof Request ? input.url : input)).pathname);
    return Promise.resolve(new Response(JSON.stringify(report()), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  console.log = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
  await createAdmissionCommand().parseAsync(args, { from: "user" });
  return { output, requested };
}

test("propr admission reads the admission route and prints the table", async () => {
  const { output, requested } = await run([]);
  assert.deepEqual(requested, ["/api/agent-run-admission"]);
  assert.ok(output.some(line => /^\(global\) +3 +3/.test(line)));
});

test("propr admission --json prints the response unchanged", async () => {
  const { output } = await run(["--json"]);
  assert.deepEqual(JSON.parse(output.join("\n")), report());
});
