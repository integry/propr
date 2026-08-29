import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { handleSquirrelStartupEvent } from './squirrel-events';

describe('Squirrel.Windows startup events', () => {
  test('creates shortcuts and schedules a clean exit after install', () => {
    const calls: unknown[] = [];
    const handled = handleSquirrelStartupEvent({
      argv: ['app.exe', '--squirrel-install'],
      execPath: '/tmp/ProPR/app-1.2.3/propr-desktop.exe',
      quit: () => calls.push('quit'),
      spawnUpdate: (command, args) => calls.push({ command, args }),
      schedule: (callback, delay) => { calls.push({ delay }); callback(); },
    });
    assert.equal(handled, true);
    assert.deepEqual(calls.at(-2), { delay: 1_000 });
    assert.equal(calls.at(-1), 'quit');
    assert.deepEqual((calls[0] as { args: string[] }).args, ['--createShortcut', 'propr-desktop.exe']);
  });

  test('does not consume first-run or unrelated arguments', () => {
    const quit = () => assert.fail('must not quit');
    assert.equal(handleSquirrelStartupEvent({ argv: ['app.exe', '--squirrel-firstrun'], quit }), false);
    assert.equal(handleSquirrelStartupEvent({ argv: ['app.exe', 'propr://open'], quit }), false);
  });
});
