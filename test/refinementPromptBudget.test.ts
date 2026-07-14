import { test, describe } from 'node:test';
import assert from 'node:assert';
import { assembleRefinementPrompt } from '../packages/core/src/services/taskPlanning/refinement.ts';
import { PlanningFailedError } from '../packages/core/src/services/planning/index.ts';

const SYS = 'SYSTEM';

function planItem(overrides: Record<string, unknown> = {}) {
  return { title: 't', body: 'b', implementation: 'i', id: 'x', ...overrides } as never;
}

describe('assembleRefinementPrompt', () => {
  test('returns the full prompt untouched when under the limit', () => {
    const { prompt, truncated } = assembleRefinementPrompt({
      systemPrompt: SYS,
      originalContext: 'ctx',
      currentPlan: [planItem()],
      instruction: 'do the thing',
      charLimit: 100_000
    });
    assert.deepStrictEqual(truncated, []);
    assert.ok(prompt.includes('do the thing'));
    assert.ok(prompt.includes('ctx'));
  });

  test('never trims when charLimit is null (token-limited models like Claude)', () => {
    const huge = 'X'.repeat(2_000_000);
    const { prompt, truncated } = assembleRefinementPrompt({
      systemPrompt: SYS,
      originalContext: huge,
      currentPlan: [planItem({ implementation: huge })],
      instruction: huge,
      charLimit: null
    });
    assert.deepStrictEqual(truncated, []);
    assert.ok(prompt.length > 6_000_000);
  });

  test('drops original context first when over the limit', () => {
    const { prompt, truncated } = assembleRefinementPrompt({
      systemPrompt: SYS,
      originalContext: 'C'.repeat(5000),
      currentPlan: [planItem()],
      instruction: 'refine',
      charLimit: 1000
    });
    assert.deepStrictEqual(truncated, ['originalContext']);
    assert.ok(prompt.length <= 1000);
    assert.ok(!prompt.includes('Original Context'));
    assert.ok(prompt.includes('refine'));
  });

  test('truncates oversized implementation bodies when dropping context is not enough', () => {
    const { prompt, truncated } = assembleRefinementPrompt({
      systemPrompt: SYS,
      currentPlan: [planItem({ implementation: 'I'.repeat(100_000) })],
      instruction: 'refine',
      charLimit: 3000
    });
    assert.ok(truncated.includes('implementation'));
    assert.ok(prompt.length <= 3000);
    assert.ok(prompt.includes('refine'));
  });

  test('truncates the instruction (head + tail) as a last resort', () => {
    const instruction = 'HEAD_MARKER' + 'X'.repeat(100_000) + 'TAIL_MARKER';
    const { prompt, truncated } = assembleRefinementPrompt({
      systemPrompt: SYS,
      currentPlan: [planItem()],
      instruction,
      charLimit: 2000
    });
    assert.ok(truncated.includes('instruction'));
    assert.ok(!truncated.includes('implementation')); // small plan body was not cut
    assert.ok(prompt.length <= 2000);
    // Keeps both ends of the instruction so the real ask survives.
    assert.ok(prompt.includes('HEAD_MARKER'));
    assert.ok(prompt.includes('TAIL_MARKER'));
  });

  test('throws an actionable error when nothing fits', () => {
    assert.throws(() => assembleRefinementPrompt({
      systemPrompt: 'S'.repeat(500),
      currentPlan: [planItem({ implementation: 'I'.repeat(10_000) })],
      instruction: 'refine',
      charLimit: 50
    }), (err: unknown) => {
      assert.ok(err instanceof PlanningFailedError);
      assert.match((err as Error).message, /too large to refine/);
      return true;
    });
  });
});
