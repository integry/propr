import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const INSTALL = join(REPOSITORY, 'scripts', 'ci-install-chromium.sh');
const WORKFLOWS = join(REPOSITORY, '.github', 'workflows');

const scratch = mkdtempSync(join(tmpdir(), 'propr-ci-chromium-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let scratchCounter = 0;
const freshDirectory = (name) => {
    scratchCounter += 1;
    const directory = join(scratch, `${String(scratchCounter).padStart(2, '0')}-${name}`);
    mkdirSync(directory, { recursive: true });
    return directory;
};

const stub = (root, name, body) => {
    writeFileSync(join(root, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(root, name), 0o755);
};

// Runs the helper with privileged and slow commands stubbed. Dependency
// attempts consume the scripted statuses; download and launch have separate
// statuses so the apt-specific tests can exercise the fallback directly.
// `sources` and `mirrors` seed the scratch /etc/apt: `mirrors` maps a list file
// name to its content, and `{mirrors}` in `sources` names the scratch directory.
function runInstall({
    statuses = [0], uid = 1000, sudoStatus = 0, mirrorWriteStatus = 0, environment = 'github-hosted',
    sources = {}, mirrors = {}, downloadStatus = 0, launchStatuses = [1, 0],
} = {}) {
    // `null` leaves RUNNER_ENVIRONMENT unset.
    const root = freshDirectory('install');
    const etc = join(root, 'etc-apt');
    mkdirSync(join(etc, 'apt.conf.d'), { recursive: true });
    mkdirSync(join(etc, 'sources.list.d'), { recursive: true });
    for (const [name, content] of Object.entries(sources)) {
        writeFileSync(join(etc, name), content.replaceAll('{mirrors}', etc));
    }
    for (const [name, content] of Object.entries(mirrors)) writeFileSync(join(etc, name), content);
    const log = join(root, 'calls');
    writeFileSync(join(root, 'statuses'), `${statuses.join('\n')}\n`);
    const launches = join(root, 'launches');
    writeFileSync(launches, `${launchStatuses.join('\n')}\n`);
    stub(root, 'id', `echo ${uid}`);
    stub(root, 'sleep', ':');
    stub(root, 'npx', `echo "npx $*" >> '${log}'`);
    stub(root, 'timeout', [
        'if [[ "$3" == node ]]; then',
        `  echo "timeout $1 $2 $3" >> '${log}'`,
        `  status=$(head -n 1 '${launches}')`,
        `  sed -i 1d '${launches}'`,
        '  exit "$status"',
        'fi',
        `echo "timeout $*" >> '${log}'`,
        `if [[ "$3 $4 $5 $6" == 'npx playwright install chromium' ]]; then exit ${downloadStatus}; fi`,
        `status=$(head -n 1 '${join(root, 'statuses')}')`,
        `sed -i 1d '${join(root, 'statuses')}'`,
        'exit "$status"',
    ].join('\n'));
    // sudo really runs `tee` (into the scratch /etc/apt) and logs the rest.
    stub(root, 'sudo', [
        `echo "sudo $*" >> '${log}'`,
        `if [[ ${sudoStatus} -ne 0 ]]; then exit ${sudoStatus}; fi`,
        'if [[ "$3" == tee ]]; then',
        `  if [[ "$4" != *apt.conf.d* && ${mirrorWriteStatus} -ne 0 ]]; then cat >/dev/null; exit ${mirrorWriteStatus}; fi`,
        '  shift 2; PATH=/usr/bin:/bin exec "$@"',
        'fi',
    ].join('\n'));
    // Already root: the helper runs `tee` itself.
    stub(root, 'tee', [
        `echo "tee $*" >> '${log}'`,
        `if [[ "$1" != *apt.conf.d* && ${mirrorWriteStatus} -ne 0 ]]; then cat >/dev/null; exit ${mirrorWriteStatus}; fi`,
        'PATH=/usr/bin:/bin exec tee "$@"',
    ].join('\n'));
    stub(root, 'pkill', `echo "pkill $*" >> '${log}'`);
    // GitHub Actions runs Linux `run` steps as `bash -e {0}`.
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', INSTALL], {
        encoding: 'utf8',
        env: {
            PATH: `${root}:${process.env.PATH}`,
            PROPR_CI_APT_ETC: etc,
            ...(environment === null ? {} : { RUNNER_ENVIRONMENT: environment }),
        },
    });
    const relative = (call) => call.replaceAll(etc, '/etc/apt');
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(relative) : [];
    const confPath = join(etc, 'apt.conf.d', '99propr-ci-network-timeouts');
    const aptConf = existsSync(confPath) ? readFileSync(confPath, 'utf8') : null;
    const mirrorList = (name) => readFileSync(join(etc, name), 'utf8');
    const attempts = calls.filter(call => call.endsWith('npx playwright install-deps chromium'));
    return { ...result, stdout: relative(result.stdout), calls, aptConf, attempts, mirrorList };
}

const DOWNLOAD = 'timeout --kill-after=15s 3m npx playwright install chromium';
const LAUNCH = 'timeout --kill-after=5s 30s node';
const ATTEMPT = 'timeout --kill-after=15s 3m npx playwright install-deps chromium';

describe('hosted Chromium install', () => {
    test('uses the pinned browser and existing libraries without touching apt when Chromium launches', () => {
        const ready = runInstall({ launchStatuses: [0], sudoStatus: 1 });
        assert.equal(ready.status, 0, ready.stderr);
        assert.deepEqual(ready.calls, [DOWNLOAD, LAUNCH]);
        assert.equal(ready.aptConf, null);
    });

    test('fails the step if the download fails or Chromium still cannot launch after apt', () => {
        const downloadFailed = runInstall({ downloadStatus: 124 });
        assert.equal(downloadFailed.status, 124);
        assert.deepEqual(downloadFailed.calls, [DOWNLOAD]);
        assert.equal(downloadFailed.aptConf, null);

        const stillBroken = runInstall({ launchStatuses: [1, 42] });
        assert.equal(stillBroken.status, 42);
        assert.deepEqual(stillBroken.calls.slice(-2), [ATTEMPT, LAUNCH]);
    });

    test('bounds every apt fetch before Playwright installs its own dependency list', () => {
        const clean = runInstall();
        assert.equal(clean.status, 0, clean.stderr);
        assert.deepEqual(clean.calls, [
            DOWNLOAD,
            LAUNCH,
            'sudo -n -- tee /etc/apt/apt.conf.d/99propr-ci-network-timeouts',
            ATTEMPT,
            LAUNCH,
        ]);
        for (const option of ['Acquire::Retries "3";', 'Acquire::http::Timeout "30";', 'Acquire::https::Timeout "30";']) {
            assert.ok(clean.aptConf.split('\n').includes(option), option);
        }
        // Playwright picks the packages; no release name is pinned here.
        assert.doesNotMatch(readFileSync(INSTALL, 'utf8'), /noble|jammy|apt-get install/);

        // Already root (a container job): no sudo.
        const asRoot = runInstall({ uid: 0 });
        assert.equal(asRoot.status, 0, asRoot.stderr);
        assert.deepEqual(asRoot.calls, [
            DOWNLOAD, LAUNCH, 'tee /etc/apt/apt.conf.d/99propr-ci-network-timeouts', ATTEMPT, LAUNCH,
        ]);
        assert.match(asRoot.aptConf, /Acquire::http::Timeout "30";/);
    });

    test('retries a timed-out install once after clearing leftover apt processes', () => {
        for (const timedOut of [124, 137]) {
            const recovered = runInstall({ statuses: [timedOut, 0] });
            assert.equal(recovered.status, 0, `retry recovers after exit ${timedOut}`);
            assert.deepEqual(recovered.attempts, [ATTEMPT, ATTEMPT]);
            assert.match(recovered.stdout, new RegExp(`::warning::Chromium install attempt 1 timed out \\(exit ${timedOut}\\)`));
            const cleanup = recovered.calls.slice(recovered.calls.indexOf(ATTEMPT) + 1, recovered.calls.lastIndexOf(ATTEMPT));
            assert.deepEqual(cleanup, [
                'sudo -n -- pkill -TERM -x apt-get',
                'sudo -n -- pkill -TERM -x dpkg',
                'sudo -n -- pkill -KILL -x apt-get',
                'sudo -n -- pkill -KILL -x dpkg',
                'sudo -n -- timeout 60s dpkg --configure -a',
            ]);

            const exhausted = runInstall({ statuses: [timedOut, timedOut] });
            assert.equal(exhausted.status, 1);
            assert.deepEqual(exhausted.attempts, [ATTEMPT, ATTEMPT]);
            assert.match(exhausted.stdout, /::error::Chromium install timed out on every attempt\./);
        }
    });

    // The hosted ubuntu-24.04 image: deb822 sources reading a mirror list, the
    // regional mirror first.
    const HOSTED_SOURCES = {
        'sources.list.d/ubuntu.sources': [
            'Types: deb',
            'URIs: mirror+file:{mirrors}/apt-mirrors.txt',
            'Suites: noble noble-updates noble-backports noble-security',
            'Components: main universe restricted multiverse',
            '',
        ].join('\n'),
    };
    const HOSTED_MIRRORS = [
        '# Mirrors for hosted runners',
        'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1',
        'https://archive.ubuntu.com/ubuntu/\tpriority:2',
        'https://security.ubuntu.com/ubuntu/\tpriority:3',
        '',
    ].join('\n');
    const MIRROR_WRITE = 'sudo -n -- tee /etc/apt/apt-mirrors.txt';

    // The mirrors apt may fetch from first in a `mirror+file:` list: the lowest
    // explicit priority, or, when no entry has one, any entry (apt breaks the
    // tie with a per-machine seed).
    const firstChoices = (list) => {
        const entries = list.split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#')).map((line) => {
            const [uri, ...tags] = line.trim().split(/\s+/);
            const priority = tags.find(tag => /^priority:\d+$/.test(tag));
            return { uri: uri.replace(/^[a-z+]+:\/\//, '').replace(/\/+$/, ''), priority: priority ? Number(priority.slice(9)) : null };
        });
        const ranked = entries.filter(entry => entry.priority !== null);
        if (ranked.length === 0) return entries.map(entry => entry.uri);
        const best = Math.min(...ranked.map(entry => entry.priority));
        return ranked.filter(entry => entry.priority === best).map(entry => entry.uri);
    };
    // Whichever mirror the timed-out attempt used, the retry cannot start there.
    const assertRetryAvoids = (before, after, name) => {
        const stalled = firstChoices(before);
        const retry = firstChoices(after);
        assert.equal(retry.length, 1, `${name}: the retry has one first choice`);
        assert.ok(!stalled.includes(retry[0]), `${name}: the retry starts at ${retry[0]}, which the first attempt may have used`);
    };

    test('retries from a different apt mirror than the one that stalled', () => {
        const recovered = runInstall({ statuses: [124, 0], sources: HOSTED_SOURCES, mirrors: { 'apt-mirrors.txt': HOSTED_MIRRORS } });
        assert.equal(recovered.status, 0, recovered.stderr);
        assert.deepEqual(recovered.attempts, [ATTEMPT, ATTEMPT]);
        assert.equal(recovered.mirrorList('apt-mirrors.txt'), [
            '# Mirrors for hosted runners',
            'https://archive.ubuntu.com/ubuntu/\tpriority:1',
            'https://security.ubuntu.com/ubuntu/\tpriority:2',
            'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:3',
            '',
        ].join('\n'));
        // The list is rewritten after apt is stopped and before the retry.
        const between = recovered.calls.slice(recovered.calls.indexOf(ATTEMPT) + 1, recovered.calls.lastIndexOf(ATTEMPT));
        assert.deepEqual(between.slice(-2), ['sudo -n -- timeout 60s dpkg --configure -a', MIRROR_WRITE]);
        assert.match(recovered.stdout, /::warning::The retry fetches from other apt mirrors before http:\/\/us-east-2\.ec2\.archive\.ubuntu\.com\/ubuntu\/ \(from \/etc\/apt\/apt-mirrors\.txt\)\./);

        // A clean first attempt leaves the runner's mirror list alone.
        const clean = runInstall({ sources: HOSTED_SOURCES, mirrors: { 'apt-mirrors.txt': HOSTED_MIRRORS } });
        assert.equal(clean.status, 0, clean.stderr);
        assert.equal(clean.mirrorList('apt-mirrors.txt'), HOSTED_MIRRORS);
        assert.ok(!clean.calls.includes(MIRROR_WRITE));

        // Still stalled on the second mirror: the step fails, bounded at two attempts.
        const exhausted = runInstall({ statuses: [137, 124], sources: HOSTED_SOURCES, mirrors: { 'apt-mirrors.txt': HOSTED_MIRRORS } });
        assert.equal(exhausted.status, 1);
        assert.deepEqual(exhausted.attempts, [ATTEMPT, ATTEMPT]);
        assert.equal(exhausted.calls.filter(call => call === MIRROR_WRITE).length, 1);
        assert.match(exhausted.stdout, /::error::Chromium install timed out on every attempt\./);

        // Already root: the list is written without sudo.
        // (As root, `timeout 60s dpkg --configure -a` takes a scripted status too.)
        const asRoot = runInstall({ uid: 0, statuses: [124, 0, 0], sources: HOSTED_SOURCES, mirrors: { 'apt-mirrors.txt': HOSTED_MIRRORS } });
        assert.equal(asRoot.status, 0, asRoot.stderr);
        assert.ok(asRoot.calls.includes('tee /etc/apt/apt-mirrors.txt'));
        assert.match(asRoot.mirrorList('apt-mirrors.txt'), /^https:\/\/archive\.ubuntu\.com\/ubuntu\/\tpriority:1$/m);
    });

    test('demotes every mirror apt would try first, keeping the others in apt order', () => {
        const mirrors = {
            // Tied first entries, other tags, and an entry with no priority (apt's last).
            'tied.txt': [
                'http://slow-a.example/ubuntu/\tarch:amd64\tpriority:5',
                'http://unranked.example/ubuntu/',
                'http://slow-b.example/ubuntu/\tpriority:5',
                'http://third.example/ubuntu/\tpriority:9',
                'http://second.example/ubuntu/\tpriority:7\ttype:deb',
                '',
            ].join('\n'),
            // One mirror only: archive.ubuntu.com goes ahead of it.
            'single.txt': 'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1\n',
            // No priorities, archive.ubuntu.com already listed: apt may have used
            // either, so security.ubuntu.com goes first.
            'unranked.txt': 'http://azure.archive.ubuntu.com/ubuntu/\nhttps://archive.ubuntu.com/ubuntu\n',
            // archive.ubuntu.com is the only mirror: it is the one that stalled.
            'archive-only.txt': 'http://archive.ubuntu.com/ubuntu/\tpriority:1\n',
        };
        const sources = {
            'sources.list': 'deb mirror+file:{mirrors}/tied.txt noble main\n# deb http://ignored.example/ubuntu noble main\n',
            'sources.list.d/single.list': 'deb [arch=amd64] mirror+file:{mirrors}/single.txt noble main\n'
                + 'deb-src mirror+file:{mirrors}/single.txt noble main\n',
            'sources.list.d/unranked.sources': 'Types: deb\nURIs: mirror+file:{mirrors}/unranked.txt\nSuites: noble\n',
            'sources.list.d/archive-only.list': 'deb mirror+file:{mirrors}/archive-only.txt noble main\n',
        };
        const run = runInstall({ statuses: [124, 0], sources, mirrors });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.mirrorList('tied.txt'), [
            'http://second.example/ubuntu/\ttype:deb\tpriority:1',
            'http://third.example/ubuntu/\tpriority:2',
            'http://unranked.example/ubuntu/\tpriority:3',
            'http://slow-a.example/ubuntu/\tarch:amd64\tpriority:4',
            'http://slow-b.example/ubuntu/\tpriority:5',
            '',
        ].join('\n'));
        assert.equal(run.mirrorList('single.txt'), [
            'http://archive.ubuntu.com/ubuntu/\tpriority:1',
            'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:2',
            '',
        ].join('\n'));
        assert.equal(run.mirrorList('unranked.txt'), [
            'http://security.ubuntu.com/ubuntu/\tpriority:1',
            'http://azure.archive.ubuntu.com/ubuntu/\tpriority:2',
            'https://archive.ubuntu.com/ubuntu\tpriority:3',
            '',
        ].join('\n'));
        assert.equal(run.mirrorList('archive-only.txt'), [
            'http://security.ubuntu.com/ubuntu/\tpriority:1',
            'http://archive.ubuntu.com/ubuntu/\tpriority:2',
            '',
        ].join('\n'));
        for (const [name, before] of Object.entries(mirrors)) assertRetryAvoids(before, run.mirrorList(name), name);
        assert.doesNotMatch(run.stdout, /the retry may reuse the slow mirror/);
        // Each list is rewritten once, even when several sources share it.
        for (const name of Object.keys(mirrors)) {
            assert.equal(run.calls.filter(call => call === `sudo -n -- tee /etc/apt/${name}`).length, 1, name);
        }

        const hosted = runInstall({ statuses: [124, 0], sources: HOSTED_SOURCES, mirrors: { 'apt-mirrors.txt': HOSTED_MIRRORS } });
        assertRetryAvoids(HOSTED_MIRRORS, hosted.mirrorList('apt-mirrors.txt'), 'apt-mirrors.txt');
    });

    test('warns when every fallback is already one of the tied mirrors', () => {
        const tied = 'http://azure.archive.ubuntu.com/ubuntu/\nhttp://archive.ubuntu.com/ubuntu/\nhttp://security.ubuntu.com/ubuntu/\n';
        const run = runInstall({ statuses: [124, 0], sources: HOSTED_SOURCES, mirrors: { 'apt-mirrors.txt': tied } });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(run.attempts, [ATTEMPT, ATTEMPT]);
        assert.match(run.stdout, /::warning::Every mirror in \/etc\/apt\/apt-mirrors\.txt is tied with the fallbacks; the retry may reuse the slow mirror\./);
        // No mirror is invented beyond the fallbacks; the list keeps its entries.
        assert.equal(run.mirrorList('apt-mirrors.txt'), [
            'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1',
            'http://archive.ubuntu.com/ubuntu/\tpriority:2',
            'http://security.ubuntu.com/ubuntu/\tpriority:3',
            '',
        ].join('\n'));
    });

    test('still retries when the mirror list cannot be used, and says so', () => {
        const noList = runInstall({ statuses: [124, 0] });
        assert.equal(noList.status, 0, noList.stderr);
        assert.deepEqual(noList.attempts, [ATTEMPT, ATTEMPT]);
        assert.match(noList.stdout, /::warning::No apt mirror list is configured; the retry uses the same apt sources\./);

        const missing = runInstall({ statuses: [124, 0], sources: HOSTED_SOURCES });
        assert.equal(missing.status, 0, missing.stderr);
        assert.deepEqual(missing.attempts, [ATTEMPT, ATTEMPT]);
        assert.match(missing.stdout, /::warning::Could not read apt mirror list \/etc\/apt\/apt-mirrors\.txt; the retry uses it unchanged\./);
        assert.ok(!missing.calls.includes(MIRROR_WRITE));

        const empty = runInstall({ statuses: [124, 0], sources: HOSTED_SOURCES, mirrors: { 'apt-mirrors.txt': '# nothing\n' } });
        assert.equal(empty.status, 0, empty.stderr);
        assert.equal(empty.mirrorList('apt-mirrors.txt'), '# nothing\n');
        assert.match(empty.stdout, /::warning::Could not read apt mirror list/);

        const unwritable = runInstall({
            statuses: [124, 0], mirrorWriteStatus: 1, sources: HOSTED_SOURCES, mirrors: { 'apt-mirrors.txt': HOSTED_MIRRORS },
        });
        assert.equal(unwritable.status, 0, unwritable.stderr);
        assert.deepEqual(unwritable.attempts, [ATTEMPT, ATTEMPT]);
        assert.equal(unwritable.mirrorList('apt-mirrors.txt'), HOSTED_MIRRORS);
        assert.match(unwritable.stdout, /::warning::Could not rewrite apt mirror list \/etc\/apt\/apt-mirrors\.txt; the retry uses it unchanged\./);
        assert.doesNotMatch(unwritable.stdout, /::warning::The retry fetches from other apt mirrors/);
    });

    test('fails closed on any other failure', () => {
        for (const status of [1, 2, 100]) {
            const failed = runInstall({ statuses: [status, 0] });
            assert.equal(failed.status, status);
            assert.deepEqual(failed.attempts, [ATTEMPT]);
            assert.doesNotMatch(failed.stdout, /Chromium install attempt/);
        }
        // Without root, the bounded apt configuration cannot be written and
        // the install does not go ahead unbounded.
        const noSudo = runInstall({ sudoStatus: 1 });
        assert.notEqual(noSudo.status, 0);
        assert.deepEqual(noSudo.attempts, []);
    });

    test('leaves the self-hosted path a browser-only download', () => {
        for (const environment of ['self-hosted', '', null]) {
            const selfHosted = runInstall({ environment });
            assert.equal(selfHosted.status, 0, selfHosted.stderr);
            assert.deepEqual(selfHosted.calls, ['npx playwright install chromium']);
            assert.equal(selfHosted.aptConf, null);
        }
    });
});

// Splits a workflow into its steps, each with the indentation it was written at.
function workflowSteps(workflow) {
    const steps = [];
    let current = null;
    for (const line of workflow.split('\n')) {
        const start = line.match(/^(\s+)- (?:name|uses|run|id):/);
        if (start) {
            current = { indent: start[1].length, lines: [line] };
            steps.push(current);
        } else if (current && (line.trim() === '' || line.match(/^ */)[0].length > current.indent)) {
            current.lines.push(line);
        } else {
            current = null;
        }
    }
    return steps.map(step => step.lines.join('\n'));
}

describe('Chromium install steps in workflows', () => {
    test('every step that installs Chromium fails fast instead of hanging', () => {
        const installs = [];
        for (const file of readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name))) {
            for (const step of workflowSteps(readFileSync(join(WORKFLOWS, file), 'utf8'))) {
                if (!/run: (?:\.\/scripts\/ci-install-chromium\.sh|.*playwright install\b)/.test(step)) continue;
                const name = step.match(/- name: (.*)/)?.[1] ?? step.split('\n')[0];
                installs.push(`${file}: ${name}`);
                const timeout = step.match(/\n\s+timeout-minutes: (\d+)\n/);
                assert.ok(timeout, `${file}: ${name} sets a step timeout`);
                assert.ok(Number(timeout[1]) <= 15, `${file}: ${name} times out within 15 minutes`);
            }
        }
        for (const expected of [
            'pr-build-check.yml: Install Chromium for PWA Smoke Test',
            'pr-test-on-label.yml: Install Chromium for browser tests',
            'desktop-release-guard.yml: Install real Chromium',
            'desktop-release-guard.yml: Install Chromium for packaged Linux x64 browser approval',
        ]) {
            assert.ok(installs.includes(expected), `${expected} is checked`);
        }
    });

    test('the hosted smoke-test install keeps its download, probes and fallback inside the step timeout', () => {
        const step = workflowSteps(readFileSync(join(WORKFLOWS, 'pr-build-check.yml'), 'utf8'))
            .find(candidate => candidate.includes('- name: Install Chromium for PWA Smoke Test'));
        const minutes = Number(step.match(/timeout-minutes: (\d+)/)[1]);
        // One download and two apt attempts with kill grace, two launch
        // probes with kill grace, and at most 5s + 60s apt cleanup.
        assert.ok(3 * (3 * 60 + 15) + 2 * (30 + 5) + 65 < minutes * 60);
    });

    test('the docs-validation setup bounds its Chromium download', () => {
        const setup = readFileSync(join(REPOSITORY, '.propr', 'setup.sh'), 'utf8');
        assert.match(setup, /\n {2}timeout --kill-after=15s 10m npm exec --workspace propr-ui -- playwright install chromium\n/);
    });
});
