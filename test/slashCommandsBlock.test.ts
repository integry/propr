import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildSlashCommandsBlock } from '../src/shared/slashCommandsBlock.js';

describe('buildSlashCommandsBlock', () => {
    test('returns a string containing HTML details block', () => {
        const result = buildSlashCommandsBlock();
        assert.ok(result.includes('<details>'));
        assert.ok(result.includes('</details>'));
        assert.ok(result.includes('<summary>'));
    });

    test('documents all six slash commands', () => {
        const result = buildSlashCommandsBlock();
        assert.ok(result.includes('/merge'), 'Should document /merge');
        assert.ok(result.includes('/review'), 'Should document /review');
        assert.ok(result.includes('/fix'), 'Should document /fix');
        assert.ok(result.includes('/switch'), 'Should document /switch');
        assert.ok(result.includes('/use'), 'Should document /use');
        assert.ok(result.includes('/ultrafix'), 'Should document /ultrafix');
    });

    test('includes table headers', () => {
        const result = buildSlashCommandsBlock();
        assert.ok(result.includes('| Command | Description | Example |'));
    });

    test('each command row has three columns', () => {
        const result = buildSlashCommandsBlock();
        const lines = result.split('\n');
        const dataRows = lines.filter(line => line.startsWith('| `/'));
        assert.strictEqual(dataRows.length, 6, 'Should have 6 command rows');
        for (const row of dataRows) {
            // Each row should have 4 pipes (3 columns)
            const pipes = (row.match(/\|/g) || []).length;
            assert.strictEqual(pipes, 4, `Row "${row}" should have 4 pipe characters`);
        }
    });

    test('/switch description mentions changing model', () => {
        const result = buildSlashCommandsBlock();
        const switchLine = result.split('\n').find(l => l.includes('`/switch`'));
        assert.ok(switchLine);
        assert.ok(switchLine.toLowerCase().includes('change') || switchLine.toLowerCase().includes('model'));
    });

    test('/use description mentions single or override', () => {
        const result = buildSlashCommandsBlock();
        const useLine = result.split('\n').find(l => l.includes('`/use`'));
        assert.ok(useLine);
        assert.ok(useLine.toLowerCase().includes('single') || useLine.toLowerCase().includes('override'));
    });
});
