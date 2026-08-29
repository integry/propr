import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SetupFilesystemCapabilities, SetupSecretCapabilities } from './setup-capabilities';
import { parseDesktopSetupRequest } from './setup-schema';

const sessionId = '00000000-0000-4000-8000-000000000000';
const baseRequest = () => ({
  sessionId,
  root: { mode: 'default' },
  reinitialize: false,
  agents: ['codex'],
  github: { mode: 'relay' },
  intake: { mode: 'routing_websocket' },
  whitelist: ['octocat'],
  repository: { fullName: 'integry/propr', alias: 'propr', baseBranch: 'main' },
});

describe('desktop setup request schema', () => {
  it('accepts the complete bounded discriminated shape and rejects unknown or mode-forbidden fields', () => {
    assert.equal(parseDesktopSetupRequest(baseRequest()).github.mode, 'relay');
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), relayUrl: 'https://attacker.invalid' }));
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), github: { mode: 'relay', relayUrl: 'https://attacker.invalid?token=x' } }));
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), agents: ['shell-agent'] }));
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), reinitialize: 'yes' }));
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), whitelist: ['bad user'] }));
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), repository: { fullName: '../escape' } }));
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), root: { mode: 'selected', capability: '/forged/path' } }));
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), intake: { mode: 'polling', webhookSecret: 'forbidden' } }));
    assert.throws(() => parseDesktopSetupRequest({ ...baseRequest(), github: { mode: 'app', appId: '1', installationId: '2', privateKeyCapability: 'A'.repeat(43) }, intake: { mode: 'routing_websocket' } }));
  });
});

describe('desktop setup filesystem capabilities', () => {
  it('binds an exact canonical directory to one session and rejects replay or path switching', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-capability-'));
    const selected = join(parent, 'selected');
    await mkdir(selected);
    const capabilities = new SetupFilesystemCapabilities();
    const issued = await capabilities.issue('directory', sessionId, selected);
    await assert.rejects(capabilities.validate(issued.capability, 'directory', '11111111-1111-4111-8111-111111111111'));
    assert.equal(await capabilities.validate(issued.capability, 'directory', sessionId), selected);
    capabilities.consume([issued.capability]);
    await assert.rejects(capabilities.validate(issued.capability, 'directory', sessionId));

    const switched = await capabilities.issue('directory', sessionId, selected);
    await rename(selected, `${selected}-old`);
    await mkdir(selected);
    await assert.rejects(capabilities.validate(switched.capability, 'directory', sessionId));
  });

  it('expires unused capabilities after a short bounded lifetime', async () => {
    const selected = await mkdtemp(join(tmpdir(), 'propr-expired-capability-'));
    let now = 1_000;
    const capabilities = new SetupFilesystemCapabilities(() => now);
    const issued = await capabilities.issue('directory', sessionId, selected);
    now += 5 * 60_000 + 1;
    await assert.rejects(capabilities.validate(issued.capability, 'directory', sessionId));
  });

  it('rejects symlinks, non-regular key files, and unsafe private-key permissions', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-key-capability-'));
    const key = join(parent, 'github-app.pem');
    await writeFile(key, 'private material', { mode: 0o644 });
    const capabilities = new SetupFilesystemCapabilities();
    await assert.rejects(capabilities.issue('private-key', sessionId, key), /group or other/);
    await chmod(key, 0o600);
    const issued = await capabilities.issue('private-key', sessionId, key);
    assert.equal(issued.label, 'github-app.pem');
    const link = join(parent, 'linked.pem');
    await symlink(key, link);
    await assert.rejects(capabilities.issue('private-key', sessionId, link), /Symbolic-link/);
    await assert.rejects(capabilities.issue('private-key', sessionId, parent));
  });
});

describe('desktop setup secret capabilities', () => {
  it('is opaque, expiring, session-bound, single-use, and rejects forgery/replay', () => {
    const sentinel = 'SENTINEL_SECRET_CAPABILITY_VALUE';
    let now = 1_000;
    const secrets = new SetupSecretCapabilities(() => now);
    const issued = secrets.issue(sessionId, sentinel);
    assert.doesNotMatch(JSON.stringify(issued), new RegExp(sentinel));
    assert.throws(() => secrets.consume('A'.repeat(43), sessionId));
    assert.throws(() => secrets.consume(issued.capability, '11111111-1111-4111-8111-111111111111'));
    const fresh = secrets.issue(sessionId, sentinel);
    assert.equal(secrets.consume(fresh.capability, sessionId), sentinel);
    assert.throws(() => secrets.consume(fresh.capability, sessionId));
    const expired = secrets.issue(sessionId, sentinel);
    now += 5 * 60_000 + 1;
    assert.throws(() => secrets.consume(expired.capability, sessionId));
  });
});
