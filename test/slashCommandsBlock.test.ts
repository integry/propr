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

    test('ends with a blank line after the details block', () => {
        const result = buildSlashCommandsBlock();
        assert.ok(result.endsWith('</details>\n\n'), 'Should leave a blank line before the next markdown paragraph');
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

    test('/fix row documents selecting all blockers and suggestions', () => {
        const row = buildSlashCommandsBlock().split('\n').find(line => line.startsWith('| `/fix`'));
        assert.ok(row?.includes('`/fix all`'));
        assert.match(row!, /blockers and suggestions/);
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

describe('buildSlashCommandsBlock with plugin commands', () => {
    test('is unchanged without plugin commands', () => {
        assert.strictEqual(buildSlashCommandsBlock([]), buildSlashCommandsBlock());
    });

    test('lists enabled plugin commands after the built-ins, with their description and plugin name', () => {
        const result = buildSlashCommandsBlock([{ name: 'example-notes', description: 'Write release notes for the work so far', pluginName: 'Example pack' }]);
        const lines = result.split('\n');
        const ultrafix = lines.findIndex(line => line.startsWith('| `/ultrafix`'));
        assert.strictEqual(lines[ultrafix + 1], '| `/example-notes` | Write release notes for the work so far (from the Example pack plugin) | `/example-notes` |');
        assert.strictEqual(lines[ultrafix + 2], '');
    });

    test('plugin text cannot break the table or add markup', () => {
        const result = buildSlashCommandsBlock([{ name: 'deploy', description: 'a | b\n<img src=x>', pluginName: 'Ship|it' }]);
        const row = result.split('\n').find(line => line.startsWith('| `/deploy`'))!;
        assert.strictEqual(row, '| `/deploy` | a \\| b img src=x (from the Ship\\|it plugin) | `/deploy` |');
        const escaped = buildSlashCommandsBlock([{ name: 'deploy', description: 'ends in \\| pipe', pluginName: 'Back\\' }]);
        const escapedRow = escaped.split('\n').find(line => line.startsWith('| `/deploy`'))!;
        assert.strictEqual(escapedRow, '| `/deploy` | ends in \\\\\\| pipe (from the Back\\\\ plugin) | `/deploy` |', 'a backslash cannot unescape a pipe');
    });
});
