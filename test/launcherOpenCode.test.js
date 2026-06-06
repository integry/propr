import assert from 'node:assert/strict';
import test from 'node:test';

test('launcher mounts OpenCode XDG config and data paths for spawned app containers', async () => {
  process.env.HOST_OPENCODE_XDG_DIR = '/home/propr/.config/opencode';
  process.env.HOST_OPENCODE_DATA_DIR = '/home/propr/.local/share/opencode';

  const { agentCredentialArgs } = await import('../docker/launcher/entrypoint.mjs');
  const args = agentCredentialArgs();

  assert.deepEqual(args, [
    '-v',
    '/home/propr/.config/opencode:/home/propr/.config/opencode',
    '-e',
    'OPENCODE_CONFIG_PATH=/home/propr/.config/opencode',
    '-v',
    '/home/propr/.local/share/opencode:/home/propr/.local/share/opencode:rw',
    '-e',
    'HOST_OPENCODE_DATA_DIR=/home/propr/.local/share/opencode'
  ]);
});
