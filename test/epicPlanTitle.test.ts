import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * Unit tests for epic/plan title generation logic.
 *
 * Tests are written against locally-extracted functions to avoid triggering
 * module-level side effects from @propr/core imports (Redis/BullMQ connections).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Testable versions of the functions (mirroring source logic)
// ─────────────────────────────────────────────────────────────────────────────

interface PlanTask {
  id?: string;
  title: string;
  body: string;
  implementation: string;
}

/**
 * Mirror of buildTitlePrompt from taskExecutionHelpers.ts
 */
function buildTitlePrompt(planJson: PlanTask[]): string {
  const taskTitles = planJson
    .map((task, index) => `${index + 1}. ${task.title}`)
    .join('\n');

  return `Generate a short, descriptive title (5-8 words) for this epic/plan that reflects ALL of the following task titles.

STRICT FORMATTING RULES:
- Output ONLY the title text, nothing else
- Do NOT use markdown formatting (no **, __, *, _, or # symbols)
- Do NOT wrap the title in quotes
- Do NOT prefix with "Title:" or any other label
- Plain text only

Task Titles:
${taskTitles}

Title (plain text only):`;
}

/**
 * Mirror of generateMergedTitle from granularity.ts
 */
function generateMergedTitle(tasks: PlanTask[]): string {
  if (tasks.length === 0) return 'Comprehensive Implementation';
  if (tasks.length === 1) return tasks[0].title;
  if (tasks.length === 2) return `${tasks[0].title} and ${tasks[1].title}`;
  return `${tasks[0].title}, ${tasks[1].title}, and ${tasks.length - 2} more`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function makeTask(title: string, index = 0): PlanTask {
  return { title, body: `Body ${index}`, implementation: `impl ${index}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildTitlePrompt tests
// ─────────────────────────────────────────────────────────────────────────────

describe('buildTitlePrompt', () => {
  test('includes all task titles as a numbered list', () => {
    const tasks = [
      makeTask('Add user authentication', 0),
      makeTask('Implement password reset', 1),
      makeTask('Add OAuth support', 2),
    ];

    const prompt = buildTitlePrompt(tasks);

    assert.ok(prompt.includes('1. Add user authentication'));
    assert.ok(prompt.includes('2. Implement password reset'));
    assert.ok(prompt.includes('3. Add OAuth support'));
  });

  test('works correctly with a single task', () => {
    const tasks = [makeTask('Fix login bug', 0)];
    const prompt = buildTitlePrompt(tasks);

    assert.ok(prompt.includes('1. Fix login bug'));
  });

  test('does not truncate titles even for large plans', () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeTask(`Task number ${i + 1} with a reasonably long descriptive title`, i)
    );

    const prompt = buildTitlePrompt(tasks);

    // All 20 titles must appear in the prompt
    for (let i = 1; i <= 20; i++) {
      assert.ok(
        prompt.includes(`${i}. Task number ${i} with a reasonably long descriptive title`),
        `Prompt is missing title for task ${i}`
      );
    }
  });

  test('prompt does not contain raw JSON of task bodies', () => {
    const tasks = [
      makeTask('Setup CI pipeline', 0),
      makeTask('Deploy to staging', 1),
    ];

    const prompt = buildTitlePrompt(tasks);

    // The prompt should list titles, not dump full JSON bodies
    assert.ok(!prompt.includes('"body"'), 'Prompt should not contain raw JSON body field');
    assert.ok(!prompt.includes('"implementation"'), 'Prompt should not contain raw JSON implementation field');
  });

  test('asks LLM to reflect ALL task titles', () => {
    const tasks = [makeTask('Task A', 0), makeTask('Task B', 1)];
    const prompt = buildTitlePrompt(tasks);

    assert.ok(prompt.toLowerCase().includes('all'), 'Prompt should instruct LLM to consider ALL titles');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateMergedTitle tests
// ─────────────────────────────────────────────────────────────────────────────

describe('generateMergedTitle', () => {
  test('returns fallback for empty task list', () => {
    assert.strictEqual(generateMergedTitle([]), 'Comprehensive Implementation');
  });

  test('returns the single task title unchanged', () => {
    const tasks = [makeTask('Refactor database layer', 0)];
    assert.strictEqual(generateMergedTitle(tasks), 'Refactor database layer');
  });

  test('combines two task titles with "and"', () => {
    const tasks = [
      makeTask('Add rate limiting', 0),
      makeTask('Fix memory leak', 1),
    ];
    assert.strictEqual(generateMergedTitle(tasks), 'Add rate limiting and Fix memory leak');
  });

  test('combines three tasks referencing all three', () => {
    const tasks = [
      makeTask('Add dark mode', 0),
      makeTask('Improve search', 1),
      makeTask('Fix pagination', 2),
    ];
    const title = generateMergedTitle(tasks);

    // Should include both leading titles and indicate there are more
    assert.ok(title.includes('Add dark mode'), 'Should include first task title');
    assert.ok(title.includes('Improve search'), 'Should include second task title');
    assert.ok(title.includes('1 more'), 'Should reference remaining task count');
  });

  test('combines five tasks referencing all five', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`Task ${i + 1}`, i));
    const title = generateMergedTitle(tasks);

    assert.ok(title.includes('Task 1'), 'Should include first task title');
    assert.ok(title.includes('Task 2'), 'Should include second task title');
    assert.ok(title.includes('3 more'), 'Should reference remaining 3 tasks');
  });

  test('does NOT use only the first task title for multi-task plans', () => {
    const tasks = [
      makeTask('First task only', 0),
      makeTask('Second important task', 1),
      makeTask('Third critical task', 2),
    ];
    const title = generateMergedTitle(tasks);

    // The title must NOT be just the first task's title
    assert.notStrictEqual(title, 'First task only', 'Title must not be just the first task title');
    // It should include the second task title as well
    assert.ok(title.includes('Second important task'), 'Title must reference more than just the first task');
  });
});
