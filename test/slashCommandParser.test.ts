import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseSlashCommand, buildCommandMeta } from '../packages/core/src/webhook/slashCommandParser.js';

describe('parseSlashCommand', () => {
    test('returns null for empty/undefined body', () => {
        assert.strictEqual(parseSlashCommand(null), null);
        assert.strictEqual(parseSlashCommand(undefined), null);
        assert.strictEqual(parseSlashCommand(''), null);
    });

    test('returns null for non-command text', () => {
        assert.strictEqual(parseSlashCommand('just a regular comment'), null);
        assert.strictEqual(parseSlashCommand('please /review this'), null);
    });

    test('parses bare /review', () => {
        const result = parseSlashCommand('/review');
        assert.deepStrictEqual(result, { command: 'review', args: [], instructions: '' });
    });

    test('parses /review with one model', () => {
        const result = parseSlashCommand('/review claude');
        assert.deepStrictEqual(result, { command: 'review', args: ['claude'], instructions: '' });
    });

    test('parses /review with multiple models', () => {
        const result = parseSlashCommand('/review llm-gemini-3-pro-preview gpt-54');
        assert.deepStrictEqual(result, { command: 'review', args: ['llm-gemini-3-pro-preview', 'gpt-54'], instructions: '' });
    });

    test('parses /review with multiline instructions', () => {
        const body = '/review claude\nPlease focus on error handling\nand test coverage';
        const result = parseSlashCommand(body);
        assert.ok(result);
        assert.strictEqual(result.command, 'review');
        assert.deepStrictEqual(result.args, ['claude']);
        assert.strictEqual(result.instructions, 'Please focus on error handling\nand test coverage');
    });

    test('parses bare /fix', () => {
        const result = parseSlashCommand('/fix');
        assert.deepStrictEqual(result, { command: 'fix', args: [], instructions: '' });
    });

    test('parses /fix with inline instructions', () => {
        const result = parseSlashCommand('/fix address the linting errors');
        assert.deepStrictEqual(result, { command: 'fix', args: ['address', 'the', 'linting', 'errors'], instructions: '' });
    });

    test('parses /fix with multiline instructions', () => {
        const body = '/fix\nPlease fix the failing test in utils.test.ts';
        const result = parseSlashCommand(body);
        assert.ok(result);
        assert.strictEqual(result.command, 'fix');
        assert.deepStrictEqual(result.args, []);
        assert.strictEqual(result.instructions, 'Please fix the failing test in utils.test.ts');
    });

    test('parses /merge', () => {
        const result = parseSlashCommand('/merge');
        assert.deepStrictEqual(result, { command: 'merge', args: [], instructions: '' });
    });

    test('trims whitespace around body', () => {
        const result = parseSlashCommand('  /review  claude  \n');
        assert.ok(result);
        assert.strictEqual(result.command, 'review');
        assert.deepStrictEqual(result.args, ['claude']);
    });

    test('parses bare /switch', () => {
        const result = parseSlashCommand('/switch');
        assert.deepStrictEqual(result, { command: 'switch', args: [], instructions: '' });
    });

    test('parses /switch with one model', () => {
        const result = parseSlashCommand('/switch claude-opus');
        assert.deepStrictEqual(result, { command: 'switch', args: ['claude-opus'], instructions: '' });
    });

    test('parses /switch with multiple models', () => {
        const result = parseSlashCommand('/switch llm-claude-opus gemini-pro');
        assert.deepStrictEqual(result, { command: 'switch', args: ['llm-claude-opus', 'gemini-pro'], instructions: '' });
    });

    test('parses /switch with model and multiline instructions', () => {
        const body = '/switch claude-opus\nPlease also review the error handling';
        const result = parseSlashCommand(body);
        assert.ok(result);
        assert.strictEqual(result.command, 'switch');
        assert.deepStrictEqual(result.args, ['claude-opus']);
        assert.strictEqual(result.instructions, 'Please also review the error handling');
    });

    test('parses bare /use', () => {
        const result = parseSlashCommand('/use');
        assert.deepStrictEqual(result, { command: 'use', args: [], instructions: '' });
    });

    test('parses /use with one model', () => {
        const result = parseSlashCommand('/use claude-sonnet');
        assert.deepStrictEqual(result, { command: 'use', args: ['claude-sonnet'], instructions: '' });
    });

    test('parses /use with multiple models', () => {
        const result = parseSlashCommand('/use llm-gemini-pro gpt-54');
        assert.deepStrictEqual(result, { command: 'use', args: ['llm-gemini-pro', 'gpt-54'], instructions: '' });
    });

    test('parses /use with model and multiline instructions', () => {
        const body = '/use gemini-pro\nFocus on performance';
        const result = parseSlashCommand(body);
        assert.ok(result);
        assert.strictEqual(result.command, 'use');
        assert.deepStrictEqual(result.args, ['gemini-pro']);
        assert.strictEqual(result.instructions, 'Focus on performance');
    });

    test('parses bare /ultrafix', () => {
        const result = parseSlashCommand('/ultrafix');
        assert.deepStrictEqual(result, { command: 'ultrafix', args: [], instructions: '' });
    });

    test('parses /ultrafix with positional goal', () => {
        const result = parseSlashCommand('/ultrafix 8');
        assert.ok(result);
        assert.strictEqual(result.command, 'ultrafix');
        assert.deepStrictEqual(result.args, ['8']);
    });

    test('parses /ultrafix with named args', () => {
        const result = parseSlashCommand('/ultrafix goal=8 max=10 pause=60 model=claude-sonnet-4-6');
        assert.ok(result);
        assert.strictEqual(result.command, 'ultrafix');
        assert.deepStrictEqual(result.args, ['goal=8', 'max=10', 'pause=60', 'model=claude-sonnet-4-6']);
    });

    test('parses /ultrafix with multiline instructions', () => {
        const body = '/ultrafix goal=3\nFocus on fixing the auth module\nand the database layer';
        const result = parseSlashCommand(body);
        assert.ok(result);
        assert.strictEqual(result.command, 'ultrafix');
        assert.deepStrictEqual(result.args, ['goal=3']);
        assert.strictEqual(result.instructions, 'Focus on fixing the auth module\nand the database layer');
    });

    test('does not match unknown commands', () => {
        assert.strictEqual(parseSlashCommand('/deploy'), null);
        assert.strictEqual(parseSlashCommand('/unknown'), null);
    });

    test('does not match command mid-line', () => {
        assert.strictEqual(parseSlashCommand('please /switch opus'), null);
        assert.strictEqual(parseSlashCommand('try /use sonnet'), null);
    });

    test('does not match command with leading blank lines', () => {
        assert.strictEqual(parseSlashCommand('\n/switch opus'), null);
        assert.strictEqual(parseSlashCommand('\n\n/use sonnet'), null);
    });

    test('handles carriage return line endings', () => {
        const result = parseSlashCommand('/switch opus\r\nPlease review');
        assert.ok(result);
        assert.strictEqual(result.command, 'switch');
        assert.deepStrictEqual(result.args, ['opus']);
        assert.strictEqual(result.instructions, 'Please review');
    });

    test('handles tab-separated arguments', () => {
        const result = parseSlashCommand('/review\tclaude\tgemini');
        assert.ok(result);
        assert.strictEqual(result.command, 'review');
        assert.deepStrictEqual(result.args, ['claude', 'gemini']);
    });

    test('returns empty instructions when only whitespace follows command line', () => {
        const result = parseSlashCommand('/use sonnet\n   \n  ');
        assert.ok(result);
        assert.strictEqual(result.command, 'use');
        assert.deepStrictEqual(result.args, ['sonnet']);
        // instructions are trimmed
        assert.strictEqual(result.instructions, '');
    });

    test('preserves multiline instructions with internal blank lines', () => {
        const body = '/fix\nFirst paragraph\n\nSecond paragraph';
        const result = parseSlashCommand(body);
        assert.ok(result);
        assert.strictEqual(result.instructions, 'First paragraph\n\nSecond paragraph');
    });
});

describe('buildCommandMeta', () => {
    test('builds review meta with no models', () => {
        const parsed = parseSlashCommand('/review')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, { mode: 'review', models: [], instructions: '' });
    });

    test('builds review meta and strips llm- prefix', () => {
        const parsed = parseSlashCommand('/review llm-gemini-3-pro-preview claude gpt-54')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'review',
            models: ['gemini-3-pro-preview', 'claude', 'gpt-54'],
            instructions: '',
        });
    });

    test('builds review meta with instructions', () => {
        const parsed = parseSlashCommand('/review\nCheck for security issues')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'review',
            models: [],
            instructions: 'Check for security issues',
        });
    });

    test('builds fix meta with no instructions', () => {
        const parsed = parseSlashCommand('/fix')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, { mode: 'fix', instructions: '' });
    });

    test('builds fix meta combining inline args and multiline instructions', () => {
        const parsed = parseSlashCommand('/fix address linting\nAlso fix the types')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'fix',
            instructions: 'address linting\nAlso fix the types',
        });
    });

    test('builds merge meta', () => {
        const parsed = parseSlashCommand('/merge')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, { mode: 'merge' });
    });

    test('builds switch meta with no models', () => {
        const parsed = parseSlashCommand('/switch')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, { mode: 'switch', models: [], instructions: '' });
    });

    test('builds switch meta and strips llm- prefix (takes only first model)', () => {
        const parsed = parseSlashCommand('/switch llm-claude-opus gemini-pro')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'switch',
            models: ['claude-opus'],
            instructions: '',
            warning: '/switch accepts only one model argument; extra arguments were ignored: gemini-pro',
        });
    });

    test('builds switch meta with instructions', () => {
        const parsed = parseSlashCommand('/switch claude-opus\nAlso fix the types')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'switch',
            models: ['claude-opus'],
            instructions: 'Also fix the types',
        });
    });

    test('builds use meta with no models', () => {
        const parsed = parseSlashCommand('/use')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, { mode: 'use', models: [], instructions: '' });
    });

    test('builds use meta and strips llm- prefix (takes only first model)', () => {
        const parsed = parseSlashCommand('/use llm-gemini-pro gpt-54')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'use',
            models: ['gemini-pro'],
            instructions: '',
            warning: '/use accepts only one model argument; extra arguments were ignored: gpt-54',
        });
    });

    test('builds use meta with instructions', () => {
        const parsed = parseSlashCommand('/use gemini-pro\nFocus on performance')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'use',
            models: ['gemini-pro'],
            instructions: 'Focus on performance',
        });
    });

    test('switch meta with single model has no warning', () => {
        const parsed = parseSlashCommand('/switch opus')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual('warning' in meta ? meta.warning : undefined, undefined);
    });

    test('use meta with single model has no warning', () => {
        const parsed = parseSlashCommand('/use sonnet')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual('warning' in meta ? meta.warning : undefined, undefined);
    });

    test('switch warning lists all extra arguments', () => {
        const parsed = parseSlashCommand('/switch opus sonnet haiku')!;
        const meta = buildCommandMeta(parsed);
        assert.ok('warning' in meta && meta.warning);
        assert.ok(meta.warning!.includes('sonnet, haiku'));
    });

    test('use warning lists all extra arguments', () => {
        const parsed = parseSlashCommand('/use opus sonnet haiku')!;
        const meta = buildCommandMeta(parsed);
        assert.ok('warning' in meta && meta.warning);
        assert.ok(meta.warning!.includes('sonnet, haiku'));
    });

    test('fix meta with only inline args treats them as instructions', () => {
        const parsed = parseSlashCommand('/fix the broken test')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'fix');
        assert.strictEqual((meta as { instructions: string }).instructions, 'the broken test');
    });

    test('review meta strips llm- prefix from multiple models', () => {
        const parsed = parseSlashCommand('/review llm-opus llm-sonnet plain-model')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual((meta as { models: string[] }).models, ['opus', 'sonnet', 'plain-model']);
    });

    test('builds ultrafix meta with defaults (all undefined when not provided)', () => {
        const parsed = parseSlashCommand('/ultrafix')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'ultrafix',
            instructions: '',
        });
    });

    test('builds ultrafix meta with positional goal', () => {
        const parsed = parseSlashCommand('/ultrafix 8')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        assert.strictEqual((meta as { goal: number }).goal, 8);
    });

    test('builds ultrafix meta with named args', () => {
        const parsed = parseSlashCommand('/ultrafix goal=8 max=10 pause=60 model=claude-sonnet-4-6')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'ultrafix',
            goal: 8,
            maxCycles: 10,
            pauseSeconds: 60,
            reviewModel: 'claude-sonnet-4-6',
            instructions: '',
        });
    });

    test('builds ultrafix meta with multiline instructions', () => {
        const parsed = parseSlashCommand('/ultrafix goal=3\nFocus on the auth module')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        assert.strictEqual((meta as { goal: number }).goal, 3);
        assert.strictEqual((meta as { instructions: string }).instructions, 'Focus on the auth module');
    });

    test('ultrafix rejects invalid numeric values with warnings (fields remain undefined)', () => {
        const parsed = parseSlashCommand('/ultrafix goal=abc max=-1 pause=xyz')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        // goal=abc is NaN → remains undefined; max=-1 is <=0 → remains undefined; pause=xyz is NaN → remains undefined
        assert.strictEqual((meta as { goal?: number }).goal, undefined);
        assert.strictEqual((meta as { maxCycles?: number }).maxCycles, undefined);
        assert.strictEqual((meta as { pauseSeconds?: number }).pauseSeconds, undefined);
        assert.ok('warning' in meta && meta.warning);
        assert.ok(meta.warning!.includes('goal'));
        assert.ok(meta.warning!.includes('max'));
        assert.ok(meta.warning!.includes('pause'));
    });

    test('ultrafix warns on unknown keys', () => {
        const parsed = parseSlashCommand('/ultrafix goal=3 foo=bar baz=1')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        assert.strictEqual((meta as { goal: number }).goal, 3);
        assert.ok('warning' in meta && meta.warning);
        assert.ok(meta.warning!.includes('foo'));
        assert.ok(meta.warning!.includes('baz'));
    });

    test('ultrafix strips llm- prefix from model', () => {
        const parsed = parseSlashCommand('/ultrafix model=llm-claude-sonnet-4-6')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { reviewModel: string }).reviewModel, 'claude-sonnet-4-6');
    });

    test('ultrafix goal at lower boundary (1) is accepted', () => {
        const parsed = parseSlashCommand('/ultrafix goal=1')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { goal: number }).goal, 1);
    });

    test('ultrafix goal at upper boundary (10) is accepted', () => {
        const parsed = parseSlashCommand('/ultrafix goal=10')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { goal: number }).goal, 10);
    });

    test('ultrafix goal=0 is rejected with warning (must be positive)', () => {
        const parsed = parseSlashCommand('/ultrafix goal=0')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { goal?: number }).goal, undefined);
        assert.ok('warning' in meta && meta.warning);
    });

    test('ultrafix goal above 10 is rejected by parser with warning', () => {
        const parsed = parseSlashCommand('/ultrafix goal=11')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { goal?: number }).goal, undefined);
        assert.ok('warning' in meta && meta.warning);
        assert.ok(meta.warning!.includes('goal'));
    });

    test('ultrafix max at lower boundary (1) is accepted', () => {
        const parsed = parseSlashCommand('/ultrafix max=1')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { maxCycles: number }).maxCycles, 1);
    });

    test('ultrafix max=0 is rejected with warning (must be positive)', () => {
        const parsed = parseSlashCommand('/ultrafix max=0')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { maxCycles?: number }).maxCycles, undefined);
        assert.ok('warning' in meta && meta.warning);
        assert.ok(meta.warning!.includes('max'));
    });

    test('ultrafix large max is accepted by parser (no upper limit)', () => {
        const parsed = parseSlashCommand('/ultrafix max=9999')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { maxCycles: number }).maxCycles, 9999);
    });

    test('ultrafix pause=0 is accepted (no pause)', () => {
        const parsed = parseSlashCommand('/ultrafix pause=0')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { pauseSeconds: number }).pauseSeconds, 0);
    });

    test('ultrafix negative pause is rejected with warning', () => {
        const parsed = parseSlashCommand('/ultrafix pause=-1')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { pauseSeconds?: number }).pauseSeconds, undefined);
        assert.ok('warning' in meta && meta.warning);
    });

    test('ultrafix keeps positional goal when mixed with named args', () => {
        const parsed = parseSlashCommand('/ultrafix 8 max=3')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        // Positional goal is preserved alongside named args
        assert.strictEqual((meta as { goal?: number }).goal, 8);
        assert.strictEqual((meta as { maxCycles?: number }).maxCycles, 3);
    });

    test('ultrafix named goal= overrides positional goal', () => {
        const parsed = parseSlashCommand('/ultrafix 8 goal=5 max=3')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        // Named goal= explicitly overrides the positional goal
        assert.strictEqual((meta as { goal?: number }).goal, 5);
        assert.strictEqual((meta as { maxCycles?: number }).maxCycles, 3);
    });

    test('ultrafix positional goal with model named arg', () => {
        const parsed = parseSlashCommand('/ultrafix 8 model=claude-sonnet-4-6')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        assert.strictEqual((meta as { goal?: number }).goal, 8);
        assert.strictEqual((meta as { reviewModel?: string }).reviewModel, 'claude-sonnet-4-6');
    });

    test('ultrafix warns on extra positional arguments', () => {
        const parsed = parseSlashCommand('/ultrafix 8 9')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        assert.strictEqual((meta as { goal?: number }).goal, 8);
        assert.ok('warning' in meta && meta.warning);
        assert.ok(meta.warning!.includes("Extra argument '9'"));
    });

    test('ultrafix warns on non-numeric positional argument', () => {
        const parsed = parseSlashCommand('/ultrafix foo')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        assert.strictEqual((meta as { goal?: number }).goal, undefined);
        assert.ok('warning' in meta && meta.warning);
        assert.ok(meta.warning!.includes('foo'));
    });

    test('ultrafix rejects decimal goal (must be integer)', () => {
        const parsed = parseSlashCommand('/ultrafix goal=7.5')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { goal?: number }).goal, undefined);
        assert.ok('warning' in meta && meta.warning);
    });

    test('ultrafix rejects decimal pause (must be integer)', () => {
        const parsed = parseSlashCommand('/ultrafix pause=30.5')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { pauseSeconds?: number }).pauseSeconds, undefined);
        assert.ok('warning' in meta && meta.warning);
    });

    test('ultrafix large pause is accepted by parser (no upper limit)', () => {
        const parsed = parseSlashCommand('/ultrafix pause=86400')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual((meta as { pauseSeconds: number }).pauseSeconds, 86400);
    });

    test('ultrafix positional goal after named args (mixed order)', () => {
        const parsed = parseSlashCommand('/ultrafix max=10 8')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        assert.strictEqual((meta as { goal?: number }).goal, 8);
        assert.strictEqual((meta as { maxCycles?: number }).maxCycles, 10);
        // No warning — this is a supported mixed form
        assert.strictEqual((meta as { warning?: string }).warning, undefined);
    });

    test('ultrafix positional goal between named args', () => {
        const parsed = parseSlashCommand('/ultrafix pause=60 8 model=claude-sonnet-4-6')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        assert.strictEqual((meta as { goal?: number }).goal, 8);
        assert.strictEqual((meta as { pauseSeconds?: number }).pauseSeconds, 60);
        assert.strictEqual((meta as { reviewModel?: string }).reviewModel, 'claude-sonnet-4-6');
    });

    test('ultrafix named goal takes precedence over later positional', () => {
        const parsed = parseSlashCommand('/ultrafix goal=5 8')!;
        const meta = buildCommandMeta(parsed);
        assert.strictEqual(meta.mode, 'ultrafix');
        // Named goal=5 was set first, positional 8 does not override
        assert.strictEqual((meta as { goal?: number }).goal, 5);
    });
});

