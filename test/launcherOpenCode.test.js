import assert from 'node:assert/strict';
import test from 'node:test';

import { agentCredentialArgs } from '../docker/launcher/orchestrator.mjs';

test('launcher mounts OpenCode XDG config and data paths for spawned app containers', () => {
  const cfg = {
    hostOpencodeXdgDir: '/home/propr/.config/opencode',
    hostOpencodeDataDir: '/home/propr/.local/share/opencode',
  };

  const args = agentCredentialArgs(cfg, { opencodeDataReadWrite: true });

  assert.deepEqual(args, [
    '-v',
    '/home/propr/.config/opencode:/home/propr/.config/opencode',
    '-e',
    'OPENCODE_CONFIG_PATH=/home/propr/.config/opencode',
    '-v',
    '/home/propr/.local/share/opencode:/home/propr/.local/share/opencode:rw',
    '-e',
    'HOST_OPENCODE_DATA_DIR=/home/propr/.local/share/opencode',
  ]);
});

test('launcher emits no legacy OpenCode mount when only XDG config is set', () => {
  const cfg = { hostOpencodeXdgDir: '/home/propr/.config/opencode' };

  const args = agentCredentialArgs(cfg);

  assert.deepEqual(args, [
    '-v',
    '/home/propr/.config/opencode:/home/propr/.config/opencode',
    '-e',
    'OPENCODE_CONFIG_PATH=/home/propr/.config/opencode',
  ]);
  assert.ok(!args.some((arg) => arg.includes('.opencode:') || arg.includes('LEGACY')), 'no legacy mount/env');
});
