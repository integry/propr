import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { promptForWebhookSecret } from './secure-secret-prompt';
import { MIN_WEBHOOK_SECRET_LENGTH } from './webhook-secret-policy';

describe('secure native webhook-secret prompt', {
  skip: process.platform === 'win32'
    ? 'The guided native secret prompt is POSIX-only; Windows desktop is remote-only.'
    : false,
}, () => {
  it('rejects 15 characters and accepts the shortest 16-character secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-secret-prompt-'));
    const executable = join(directory, 'zenity');
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write(process.env.PROPR_TEST_WEBHOOK_SECRET ?? "");\n', { mode: 0o700 });
    await chmod(executable, 0o700);
    const previousPath = process.env.PATH;
    const previousSecret = process.env.PROPR_TEST_WEBHOOK_SECRET;
    process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
    try {
      process.env.PROPR_TEST_WEBHOOK_SECRET = 'a'.repeat(MIN_WEBHOOK_SECRET_LENGTH - 1);
      await assert.rejects(promptForWebhookSecret(), /invalid value/);
      process.env.PROPR_TEST_WEBHOOK_SECRET = 'b'.repeat(MIN_WEBHOOK_SECRET_LENGTH);
      assert.equal(await promptForWebhookSecret(), 'b'.repeat(MIN_WEBHOOK_SECRET_LENGTH));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousSecret === undefined) delete process.env.PROPR_TEST_WEBHOOK_SECRET;
      else process.env.PROPR_TEST_WEBHOOK_SECRET = previousSecret;
    }
  });
});
