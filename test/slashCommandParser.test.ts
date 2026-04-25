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

    test('does not match unknown commands', () => {
        assert.strictEqual(parseSlashCommand('/deploy'), null);
        assert.strictEqual(parseSlashCommand('/unknown'), null);
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

    test('builds switch meta and strips llm- prefix', () => {
        const parsed = parseSlashCommand('/switch llm-claude-opus gemini-pro')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'switch',
            models: ['claude-opus', 'gemini-pro'],
            instructions: '',
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

    test('builds use meta and strips llm- prefix', () => {
        const parsed = parseSlashCommand('/use llm-gemini-pro gpt-54')!;
        const meta = buildCommandMeta(parsed);
        assert.deepStrictEqual(meta, {
            mode: 'use',
            models: ['gemini-pro', 'gpt-54'],
            instructions: '',
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
});
