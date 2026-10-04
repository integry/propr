import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, mock, test } from 'node:test';

import {
  extractWholeJsonArray,
  incompletePlanItems,
  validatePlanText,
} from '../packages/core/src/services/taskPlanning/planValidation.js';

const task = (title: string) => ({
  title,
  body: `Body of ${title} with "quotes", a backslash \\ and\nnewlines`,
  implementation: `Steps for ${title}: ${'detail '.repeat(80)}`,
});
const plan = JSON.stringify([task('A'), task('B'), task('C')], null, 2);
// Typical model mistakes: an unescaped quote and a missing comma.
const broken = plan.replace('\\"quotes\\"', '"quotes"').replace('},\n  {\n    "title": "C"', '}\n  {\n    "title": "C"');

describe('plan validator', () => {
  test('accepts a complete plan, alone or against its own original', async () => {
    assert.deepEqual(await validatePlanText(plan), { valid: true, taskCount: 3, errors: [] });
    assert.equal((await validatePlanText(plan, plan)).valid, true);
  });

  test('accepts a syntax-only repair of a broken original', async () => {
    assert.throws(() => JSON.parse(broken));
    assert.deepEqual(await validatePlanText(plan, broken), { valid: true, taskCount: 3, errors: [] });
  });

  test('preserves literal Unicode escapes and decodes actual escapes exactly once', async () => {
    const original = String.raw`[{"title":"A","body":"Match \\u0041, \u0041, \\\u0041, \\u005c and \uD83D\uDE00" "implementation":"c"}]`;
    const repaired = original.replace('" "implementation"', '", "implementation"');
    assert.throws(() => JSON.parse(original));
    assert.equal((await validatePlanText(repaired, original)).valid, true);
    // Equivalent JSON encodings preserve text too.
    assert.equal((await validatePlanText(JSON.stringify(JSON.parse(repaired)), original)).valid, true);
    const changed = JSON.parse(repaired);
    changed[0].body = changed[0].body.replace(String.raw`\u0041`, 'A');
    assert.equal((await validatePlanText(JSON.stringify(changed), original)).valid, false);
  });

  test('compares original occurrences, task order and every field association', async () => {
    const a = { title: 'A', body: 'a', implementation: 'x', extra: { enabled: true, labels: ['one', 'two'] } };
    const b = { title: 'B', body: 'b', implementation: 'y', extra: { enabled: true, labels: ['six', 'ten'] } };
    assert.equal(JSON.stringify(a).length, JSON.stringify(b).length);
    const original = `[${JSON.stringify(a)} ${JSON.stringify(b)}]`;
    const cases = [
      [a, a], // Equal task count and size, but B was replaced by existing A.
      [b, a], // Every string survives, in the wrong task order.
      [a, { ...b, body: b.implementation, implementation: b.body }],
      [a, { ...b, body: a.body }],
      [a, { ...b, extra: a.extra }],
      [a, { title: b.title, body: b.body, implementation: b.implementation }],
      [a, { ...b, added: 'b' }],
    ];
    for (const repaired of cases) {
      assert.equal((await validatePlanText(JSON.stringify(repaired), original)).valid, false, JSON.stringify(repaired));
    }
    assert.equal((await validatePlanText(JSON.stringify([a, b]), original)).valid, true);
    assert.equal((await validatePlanText(JSON.stringify([{ ...a, extra: { labels: ['one', 'two'], enabled: true } }, b]), original)).valid, true);
    assert.equal((await validatePlanText(JSON.stringify([a, a]), `[${JSON.stringify(a)} ${JSON.stringify(a)}]`)).valid, true);
  });

  test('does not lose duplicate original fields or unrecognized original text', async () => {
    const repaired = '[{"title":"A","body":"b","implementation":"c"}]';
    for (const original of [
      repaired.replace('"body":"b"', '"body":"lost","body":"b"'),
      repaired.replace('"body":"b"', '"body":"b" unexplained'),
    ]) {
      assert.equal((await validatePlanText(repaired, original)).valid, false);
    }
  });

  test('reports invalid JSON, a non-array and missing fields', async () => {
    assert.match((await validatePlanText(broken)).errors[0], /is not valid JSON/);
    assert.match((await validatePlanText('{"title":"x"}')).errors[0], /must contain a JSON array/);
    assert.deepEqual((await validatePlanText('[]')).errors, ['the plan has no tasks']);
    assert.deepEqual((await validatePlanText(JSON.stringify([{ content: 'raw text' }]))).errors, [
      'task 1 has no non-empty "title" string',
      'task 1 has no non-empty "body" string',
      'task 1 has no non-empty "implementation" string',
    ]);
  });

  test('rejects a repair that drops, rewords or invents content', async () => {
    const dropped = await validatePlanText(JSON.stringify([task('A'), task('B')]), broken);
    assert.equal(dropped.valid, false);
    assert.ok(dropped.errors.some(error => /has 3 tasks but plan\.json has 2/.test(error)));

    const reworded = await validatePlanText(JSON.stringify([task('A'), task('B'), { ...task('C'), body: 'A short summary.' }]), broken);
    assert.equal(reworded.valid, false);
    assert.match(reworded.errors[0], /task 3 does not match original.txt/);

    const invented = await validatePlanText(JSON.stringify([task('A'), task('B'), task('C'), task('D')]), broken);
    assert.equal(invented.valid, false);
  });
});

describe('plan response shape', () => {
  test('extracts a whole array from prose and code fences', () => {
    assert.equal(extractWholeJsonArray(plan), plan);
    assert.equal(extractWholeJsonArray(`Here is the plan:\n\`\`\`json\n${plan}\n\`\`\`\nDone.`), plan);
  });

  test('treats a response that starts or ends mid-plan as a fragment', () => {
    // The tail of a long answer, as saved for plan 027d8f35.
    assert.equal(extractWholeJsonArray('error\\": { \\"code\\": \\"GITHUB_FORBIDDEN\\" } }\nAfter editing, run the build."}]'), null);
    assert.equal(extractWholeJsonArray('"body": "x"}, {"title": "y", "body": "z", "implementation": "w"}]'), null);
    assert.equal(extractWholeJsonArray(plan.slice(0, plan.length / 2)), null);
    assert.equal(extractWholeJsonArray('no plan here'), null);
  });

  test('requires the closing outer bracket outside strings and rejects trailing tasks', () => {
    const truncated = '[{"title":"A","body":"b" "implementation":"Use [x] safely"}, {"title":"B","body":"unfinished';
    assert.equal(extractWholeJsonArray(truncated), null);
    assert.equal(extractWholeJsonArray(`[${JSON.stringify(task('A'))}, [${JSON.stringify(task('B'))}]`), null);
    assert.equal(extractWholeJsonArray(`${plan}, {"title":"D","body":"unfinished`), null);
    assert.equal(extractWholeJsonArray(`\`\`\`json\n${plan}\n\`\`\`\n, {"title":"D"`), null);
    assert.equal(extractWholeJsonArray(`${plan}\n${plan}`), null);
    const withSyntaxError = JSON.stringify([{ ...task('A'), implementation: 'Use [x], "quotes", a slash \\ and ```\n fences safely' }])
      .replace(',"implementation"', ' "implementation"');
    assert.equal(extractWholeJsonArray(withSyntaxError), withSyntaxError);
    assert.equal(extractWholeJsonArray(broken), broken);
  });

  test('passes repairable quotes containing delimiters through to syntax-only validation', async () => {
    for (const field of ['title', 'body', 'implementation']) {
      for (const quoted of [']', '[', '{', 'text }]', 'text [ {']) {
        const repaired = [{ title: 'A', body: 'b', implementation: 'c', [field]: `Use "${quoted}" here` }];
        const valid = JSON.stringify(repaired);
        const original = valid.replaceAll(String.raw`\"`, '"');
        assert.throws(() => JSON.parse(original));
        assert.equal(extractWholeJsonArray(original), original);
        assert.equal(extractWholeJsonArray(`Here is the plan:\n\`\`\`json\n${original}\n\`\`\``), original);
        assert.equal((await validatePlanText(valid, original)).valid, true);
        assert.equal(extractWholeJsonArray(original.slice(0, -1)), null);
        assert.equal(extractWholeJsonArray(`${original}, {"title":"trailing"`), null);
      }
    }
  });

  test('uses tolerant boundaries for nested object and array string values too', async () => {
    const original = '[{"title":"A","body":"b","implementation":"c","extra":{"note":"Use "]" here","labels":["Use "text }" here"]}}]';
    const repaired = JSON.stringify([{ title: 'A', body: 'b', implementation: 'c',
      extra: { note: 'Use "]" here', labels: ['Use "text }" here'] } }]);
    assert.equal(extractWholeJsonArray(original), original);
    assert.equal((await validatePlanText(repaired, original)).valid, true);
    assert.equal(extractWholeJsonArray(original.slice(0, -1)), null);
  });

  test('lists incomplete tasks by position', () => {
    assert.deepEqual(incompletePlanItems([task('A'), { title: 'B', body: ' ', implementation: 'x' }, 'text', null]), [2, 3, 4]);
  });
});

// --- scratch-workspace agent ------------------------------------------------

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'plan-workspaces-'));
after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
process.env.PROPR_PLAN_WORKSPACE_ROOT = workspaceRoot;

await mock.module('../packages/core/src/utils/logger.js', {
  defaultExport: { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn(), withCorrelation: () => ({ info: mock.fn(), warn: mock.fn(), error: mock.fn() }) },
});
const { runPlanFileAgent } = await import('../packages/core/src/services/taskPlanning/planFileAgent.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(async () => closeConnection());

type TaskCall = { worktreePath: string; prompt: string; model: string; taskId: string; maxTurns?: number; metadata: Record<string, unknown>; issueRef: Record<string, unknown> };
const runner = (edit: (workspace: string) => void, success = true) => {
  const calls: TaskCall[] = [];
  return {
    calls,
    session: {
      executeTask: async (options: TaskCall) => {
        calls.push(options);
        edit(options.worktreePath);
        return { success, error: success ? undefined : 'agent crashed', logs: '', modifiedFiles: [], modelUsed: options.model, executionTimeMs: 1 };
      },
    },
  };
};
const repairOptions = (session: unknown) => ({
  purpose: 'repair' as const,
  prompt: 'Fix plan.json',
  files: { 'plan.json': broken, 'original.txt': broken },
  original: broken,
  model: 'codex:gpt-6-astra',
  draftId: 'draft-1',
  repository: 'owner/repo',
  githubToken: 'token',
  executionType: 'plan-generation' as const,
  routingSession: session as never,
});

describe('plan file agent', () => {
  test('gives the agent the files and validator and returns the validated plan', async () => {
    let seen: Record<string, string> = {};
    const { calls, session } = runner(workspace => {
      seen = Object.fromEntries(['plan.json', 'original.txt', 'validate-plan.mjs'].map(name => [name, readFileSync(path.join(workspace, name), 'utf8')]));
      writeFileSync(path.join(workspace, 'plan.json'), plan);
    });

    assert.deepEqual(await runPlanFileAgent(repairOptions(session)), JSON.parse(plan));
    assert.equal(seen['plan.json'], broken);
    assert.equal(seen['original.txt'], broken);
    assert.match(seen['validate-plan.mjs'], /Validates a ProPR plan/);
    assert.equal(calls[0].model, 'gpt-6-astra');
    assert.equal(calls[0].taskId, 'draft-1');
    assert.equal(calls[0].maxTurns, 200, 'repair is not cut off by a low host turn limit');
    assert.deepEqual(calls[0].issueRef, { number: 0, repoOwner: 'owner', repoName: 'repo' });
    // Logged as plan work for this draft, not as issue implementation.
    assert.deepEqual(calls[0].metadata.proprLogAttribution, {
      executionType: 'plan-generation',
      workRef: { workType: 'plan', taskId: undefined, taskNumber: undefined, prNumber: undefined, planDraftId: 'draft-1', workRepository: 'owner/repo' },
    });
    assert.equal(calls[0].metadata.planFileAgent, 'repair');
    assert.deepEqual(readdirSync(workspaceRoot), [], 'the workspace is removed');
  });

  test('rejects a result that only passes an edited validator or original', async () => {
    const { session } = runner(workspace => {
      writeFileSync(path.join(workspace, 'validate-plan.mjs'), 'process.exit(0)');
      writeFileSync(path.join(workspace, 'original.txt'), JSON.stringify([task('A')]));
      writeFileSync(path.join(workspace, 'plan.json'), JSON.stringify([task('A')]));
    });
    await assert.rejects(runPlanFileAgent(repairOptions(session)), /Plan repair did not produce a valid plan: .*keep every task/);
  });

  test('rejects duplicated tasks even if the agent replaces the original after an await', async () => {
    const a = { title: 'A', body: 'a', implementation: 'x' };
    const b = { title: 'B', body: 'b', implementation: 'y' };
    const original = `[${JSON.stringify(a)} ${JSON.stringify(b)}]`;
    const duplicate = JSON.stringify([a, a]);
    const session = {
      executeTask: async ({ worktreePath }: TaskCall) => {
        await Promise.resolve();
        writeFileSync(path.join(worktreePath, 'original.txt'), duplicate);
        writeFileSync(path.join(worktreePath, 'plan.json'), duplicate);
        return { success: true };
      },
    };
    await assert.rejects(runPlanFileAgent({
      ...repairOptions(session), original,
      files: { 'original.txt': original, 'plan.json': original },
    }), /task 2 does not match original.txt/);
    assert.deepEqual(readdirSync(workspaceRoot), []);
  });

  test('reports a missing plan with the agent failure', async () => {
    const { session } = runner(workspace => rmSync(path.join(workspace, 'plan.json')), false);
    await assert.rejects(runPlanFileAgent(repairOptions(session)), /produced no plan\.json\. The agent reported: agent crashed/);
  });

  test('accepts a valid plan even when the agent exits unsuccessfully', async () => {
    const { session } = runner(workspace => writeFileSync(path.join(workspace, 'plan.json'), plan), false);
    assert.equal((await runPlanFileAgent(repairOptions(session))).length, 3);
  });
});

