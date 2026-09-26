#!/usr/bin/env node
import { resolve } from 'node:path';
import { runNodeTestProof } from './lib/node-test-proof.mjs';

// Each file must run and pass at least one test; the totals are reported by
// the runner and logged, not compared with a hand-maintained count.
const root = resolve(import.meta.dirname, '..');
const files = [
  'packages/cli/src/commands/connectCommand.test.ts',
  'packages/cli/src/connectRootAuthority.test.ts',
  'packages/cli/src/commands/initStack.test.ts',
  'packages/cli/src/config/ConfigManager.test.ts',
  'packages/cli/src/index.test.ts',
  'packages/cli/src/orchestrator/index.test.ts',
  'packages/api/test/statusRoutes.test.ts',
];

const proof = runNodeTestProof({
  label: 'Platform-safe Connect proof',
  root,
  files,
  nodeArgs: ['--import', 'tsx', '--experimental-test-module-mocks'],
  timeoutMs: 90_000,
  maxBuffer: 16 * 1024 * 1024,
});
if (!proof.ok) process.exitCode = 1;
