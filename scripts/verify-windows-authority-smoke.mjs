#!/usr/bin/env node
import { closeSync, constants, mkdtempSync, openSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const stages = Object.freeze([
  'PATH_NAME', 'CHANNEL_CREATE', 'SCRIPT_LOAD', 'JOB_CREATE', 'JOB_ASSIGN', 'PARENT_OPEN',
  'PROCESS_DACL', 'IMAGE_OPEN', 'IMAGE_HASH', 'IMAGE_IDENTITY', 'OWNER_DACL', 'REPARSE',
  'LOCK', 'READY_FRAME', 'PRE_CHALLENGE', 'BATCH_LAUNCH', 'FD_DUPLICATE', 'BATCH_RESPONSE',
  'POST_CHALLENGE', 'SHUTDOWN',
]);
const unknownIndex = stages.length;
let authority;
let fixture;
let created;
try {
  if (process.platform !== 'win32') throw new Error('unsupported');
  authority = await import('../packages/cli/dist/connectRootAuthority.js');
  if (stages.length !== authority.WINDOWS_SUPERVISOR_STAGE_VALUES.length
    || stages.some((stage, index) => stage !== authority.WINDOWS_SUPERVISOR_STAGE_VALUES[index])) {
    throw new Error('stage-contract');
  }
  fixture = mkdtempSync(join(userInfo().homedir, 'propr-authority-smoke-'));
  const emptyFile = join(fixture, 'empty');
  created = openSync(emptyFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  closeSync(created);
  created = undefined;
  // The production protect request performs protection and a same-handle
  // inspection for both entries in one strict batch-v1 inherited-fd launch.
  await authority.protectWindowsSetupEntries([
    { path: fixture, kind: 'directory' },
    { path: emptyFile, kind: 'file' },
  ]);
  await authority.closeWindowsAuthorityCapability({ requireGracefulShutdown: true });
  process.stdout.write('Windows authority smoke: PASS\n');
} catch (error) {
  let stage;
  try { stage = authority?.windowsAuthorityStageFromError(error); } catch { /* UNKNOWN remains fixed. */ }
  const index = stage === undefined ? unknownIndex : stages.indexOf(stage);
  process.stderr.write(`[win-authority-stage:${stage ?? 'UNKNOWN'}:${index < 0 ? unknownIndex : index}]\n`);
  process.exitCode = 1;
} finally {
  if (created !== undefined) {
    try { closeSync(created); } catch { /* Fixed diagnostic above owns failure output. */ }
  }
  try { await authority?.closeWindowsAuthorityCapability(); } catch { /* Fixed diagnostic above owns failure output. */ }
  if (fixture !== undefined) {
    try { rmSync(fixture, { recursive: true, force: true }); } catch { /* Fixed diagnostic above owns failure output. */ }
  }
}
