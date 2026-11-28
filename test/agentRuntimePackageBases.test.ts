import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Sprite } from '@fly/sprites';
import type { FakeSprite } from './helpers/fakeSprites.ts';

// Sprites boot Fly's Ubuntu base image, not Dockerfile.agent: package names are checked against the
// Sprite base each new Sprite reports. The recorded base lives in the config store, so use a private one.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-package-bases-'));
process.env.DATA_DIR = testDataDir;

let bases: typeof import('../packages/core/src/agents/runtime/agentRuntimePackageBases.js');
let provisioning: typeof import('../packages/core/src/agents/runtime/sprites/spritesProvisioning.js');
let index: typeof import('../packages/core/src/agents/runtime/agentRuntimePackageIndex.js');
let connection: typeof import('../packages/core/src/db/connection.js');
let fakes: typeof import('./helpers/fakeSprites.js');

before(async () => {
    bases = await import('../packages/core/src/agents/runtime/agentRuntimePackageBases.js');
    provisioning = await import('../packages/core/src/agents/runtime/sprites/spritesProvisioning.js');
    index = await import('../packages/core/src/agents/runtime/agentRuntimePackageIndex.js');
    connection = await import('../packages/core/src/db/connection.js');
    fakes = await import('./helpers/fakeSprites.js');
    await connection.runMigrations();
});

after(async () => {
    index.setAgentImagePackageIndexLoader();
    await connection.closeConnection();
    fs.rmSync(testDataDir, { recursive: true, force: true });
});

const OS_RELEASE = `PRETTY_NAME="Ubuntu 26.04 LTS"
NAME="Ubuntu"
VERSION_ID="26.04"
VERSION="26.04 LTS (Resolute Raccoon)"
VERSION_CODENAME=resolute
ID=ubuntu
`;
const UBUNTU_SOURCES = `Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: resolute resolute-updates resolute-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: resolute-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb-src
URIs: http://archive.ubuntu.com/ubuntu/
Suites: resolute
Components: main
`;
const probeOutput = (osRelease = OS_RELEASE, list = '', deb822 = UBUNTU_SOURCES) =>
    `${osRelease}@@propr-arch\namd64\n@@propr-list\n${list}@@propr-deb822\n${deb822}\n`;

test('a Sprite probe yields its distribution and binary apt sources from deb822 and one-line files', () => {
    const base = bases.parseSpritePackageBaseProbe(probeOutput(OS_RELEASE,
        '# comment\ndeb [arch=amd64 signed-by=/etc/apt/keyrings/x.gpg] https://example.test/apt stable main\ndeb-src http://archive.ubuntu.com/ubuntu resolute main\n'));
    assert.ok(base);
    assert.equal(base.label, 'Ubuntu 26.04 LTS (resolute)');
    assert.equal(base.architecture, 'amd64');
    const listed = base.sources.map(source => `${source.url} ${source.suite} ${source.component}`);
    assert.equal(listed[0], 'https://example.test/apt stable main');
    assert.ok(listed.includes('https://archive.ubuntu.com/ubuntu resolute universe'), 'archives are read over HTTPS');
    assert.ok(listed.includes('https://security.ubuntu.com/ubuntu resolute-security main'));
    assert.equal(listed.length, 1 + 3 * 4 + 4, 'deb-src stanzas and lines are skipped');
    // The documented default is what a stock Sprite reports, so the first Sprite changes nothing.
    assert.equal(bases.parseSpritePackageBaseProbe(probeOutput())!.key, bases.DEFAULT_SPRITE_PACKAGE_BASE.key);
    assert.equal(bases.parseSpritePackageBaseProbe('no markers'), undefined);
    assert.equal(bases.parseSpritePackageBaseProbe(probeOutput(OS_RELEASE, '', '')), undefined, 'no apt source, no base');
});

function probingClient(stdout: () => string, log: string[] = []) {
    const client = new fakes.FakeSprites();
    client.setup = (sprite: FakeSprite) => {
        const execFile = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd, args, options) => {
            if (cmd === bases.SPRITE_PACKAGE_BASE_PROBE[0] && args[1] === bases.SPRITE_PACKAGE_BASE_PROBE[2]) {
                log.push('probe');
                return { exitCode: 0, stdout: stdout(), stderr: '' };
            }
            if (args.includes('propr-runtime-packages')) {
                log.push(`install ${args[args.indexOf('-c') + 1].includes('rm -rf /var/lib/apt/lists') ? 'clean' : 'keep-lists'}`);
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            return execFile(cmd, args, options);
        };
    };
    return client;
}

test('detection records a changed Sprite base, re-checks the list against it before apt, and keeps the apt lists', async () => {
    const debianLike = probeOutput('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nVERSION_CODENAME=trixie\n',
        'deb http://deb.debian.org/debian trixie main\n', '');
    const checked: string[] = [];
    index.setAgentImagePackageIndexLoader(async (_signal, base) => base!.label.startsWith('Ubuntu')
        ? index.createAgentImagePackageIndex({ figlet: ['2.2.5-3build1'], libssl3t64: ['3.5.3-1ubuntu2'] })
        : index.createAgentImagePackageIndex({ figlet: ['2.2.5-3'] }));
    const check = async (packages: readonly string[], signal?: AbortSignal) => {
        const base = await bases.loadSpritePackageBase();
        checked.push(base.label);
        await index.assertAgentRuntimePackagesInIndex(packages, signal, base, 'Sprites');
    };
    const source = (packages: string[]) => Object.assign(index.indexCheckedAgentRuntimePackages(async () => packages, check),
        { detectBase: (sprite: Sprite, signal: AbortSignal) => bases.detectSpritePackageBase(sprite, signal) });

    // A stock Sprite: the default base was already right; one check, and the lists stay in the checkpoint.
    const log: string[] = [];
    const pool = new provisioning.SpritePool(probingClient(() => probeOutput(), log), undefined, source(['libssl3t64']));
    const slot = await pool.acquire(new AbortController().signal);
    assert.deepEqual(log, ['probe', 'install keep-lists']);
    assert.deepEqual(checked, ['Ubuntu 26.04 LTS (resolute)']);
    await pool.release(slot);
    await pool.close();

    // Fly moves Sprites to another base: the Ubuntu-only name is refused before apt, and the Sprite deleted.
    checked.length = 0;
    const moved = probingClient(() => debianLike);
    const next = new provisioning.SpritePool(moved, undefined, source(['libssl3t64']));
    await assert.rejects(next.acquire(new AbortController().signal), /not available to Sprites from the Debian GNU\/Linux 13 \(trixie\) apt sources.*Unknown package: libssl3t64/);
    assert.deepEqual(checked, ['Ubuntu 26.04 LTS (resolute)', 'Debian GNU/Linux 13 (trixie)']);
    assert.equal(moved.created.length, 1);
    assert.deepEqual(moved.deleted, [moved.created[0].name]);
    assert.equal((await bases.loadSpritePackageBase()).label, 'Debian GNU/Linux 13 (trixie)', 'Settings validates against the recorded base');
    await next.close();
});

test('a probe that fails or reports nothing usable does not fail provisioning', async () => {
    const log: string[] = [];
    const client = probingClient(() => { throw new Error('exec failed'); }, log);
    const pool = new provisioning.SpritePool(client, undefined, Object.assign(async () => ['figlet'], {
        detectBase: (sprite: Sprite, signal: AbortSignal) => bases.detectSpritePackageBase(sprite, signal) }));
    const slot = await pool.acquire(new AbortController().signal);
    assert.deepEqual(log, ['probe', 'install keep-lists']);
    await pool.release(slot);
    await pool.close();
});

test('warm Sprites with another package list are deleted in the background, not on the run\'s acquire path', async () => {
    const client = new fakes.FakeSprites();
    let packages = ['figlet'];
    const pool = new provisioning.SpritePool(client, undefined, async () => packages);
    const signal = new AbortController().signal;
    const first = await pool.acquire(signal);
    await pool.release(first);
    let releaseDelete!: () => void;
    const held = new Promise<void>(resolve => { releaseDelete = resolve; });
    const deleteSprite = client.deleteSprite.bind(client);
    client.deleteSprite = async (name: string) => { await held; return deleteSprite(name); };
    packages = ['figlet', 'jq'];
    const fresh = await pool.acquire(signal);
    assert.notEqual(fresh.sprite.name, first.sprite.name, 'the run got a new Sprite while the stale delete is still pending');
    assert.ok(!client.deleted.includes(first.sprite.name));
    releaseDelete();
    await pool.release(fresh);
    await pool.close();
    assert.ok(client.deleted.includes(first.sprite.name), 'close waits for the background delete');
});
