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

// Runs the helper with every privileged or slow command stubbed. Each
// `timeout` call (one per install attempt) consumes the next scripted status.
function runInstall({ statuses = [0], uid = 1000, sudoStatus = 0, environment = 'github-hosted' } = {}) {
    // `null` leaves RUNNER_ENVIRONMENT unset.
    const root = freshDirectory('install');
    const log = join(root, 'calls');
    writeFileSync(join(root, 'statuses'), `${statuses.join('\n')}\n`);
    stub(root, 'id', `echo ${uid}`);
    stub(root, 'sleep', ':');
    stub(root, 'npx', `echo "npx $*" >> '${log}'`);
    stub(root, 'timeout', [
        `echo "timeout $*" >> '${log}'`,
        `status=$(head -n 1 '${join(root, 'statuses')}')`,
        `sed -i 1d '${join(root, 'statuses')}'`,
        'exit "$status"',
    ].join('\n'));
    stub(root, 'sudo', [
        `echo "sudo $*" >> '${log}'`,
        `if [[ "$*" == *" tee "* ]]; then cat > '${join(root, 'apt.conf')}'; fi`,
        `exit ${sudoStatus}`,
    ].join('\n'));
    stub(root, 'tee', `echo "tee $*" >> '${log}'; cat > '${join(root, 'apt.conf')}'`);
    stub(root, 'pkill', `echo "pkill $*" >> '${log}'`);
    // GitHub Actions runs Linux `run` steps as `bash -e {0}`.
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', INSTALL], {
        encoding: 'utf8',
        env: { PATH: `${root}:${process.env.PATH}`, ...(environment === null ? {} : { RUNNER_ENVIRONMENT: environment }) },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const aptConf = existsSync(join(root, 'apt.conf')) ? readFileSync(join(root, 'apt.conf'), 'utf8') : null;
    const attempts = calls.filter(call => call.startsWith('timeout --kill-after'));
    return { ...result, calls, aptConf, attempts };
}

const ATTEMPT = 'timeout --kill-after=15s 3m npx playwright install --with-deps chromium';

describe('hosted Chromium install', () => {
    test('bounds every apt fetch before Playwright installs its own dependency list', () => {
        const clean = runInstall();
        assert.equal(clean.status, 0, clean.stderr);
        assert.deepEqual(clean.calls, [
            'sudo -n -- tee /etc/apt/apt.conf.d/99propr-ci-network-timeouts',
            ATTEMPT,
        ]);
        for (const option of ['Acquire::Retries "3";', 'Acquire::http::Timeout "30";', 'Acquire::https::Timeout "30";']) {
            assert.ok(clean.aptConf.split('\n').includes(option), option);
        }
        // Playwright picks the packages; no release name is pinned here.
        assert.doesNotMatch(readFileSync(INSTALL, 'utf8'), /noble|jammy|apt-get install/);

        // Already root (a container job): no sudo.
        const asRoot = runInstall({ uid: 0 });
        assert.equal(asRoot.status, 0, asRoot.stderr);
        assert.deepEqual(asRoot.calls, ['tee /etc/apt/apt.conf.d/99propr-ci-network-timeouts', ATTEMPT]);
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

    test('fails closed on any other failure', () => {
        for (const status of [1, 2, 100]) {
            const failed = runInstall({ statuses: [status, 0] });
            assert.equal(failed.status, status);
            assert.deepEqual(failed.attempts, [ATTEMPT]);
            assert.doesNotMatch(failed.stdout, /::warning::/);
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

    test('the hosted smoke-test install keeps its attempts inside the step timeout', () => {
        const step = workflowSteps(readFileSync(join(WORKFLOWS, 'pr-build-check.yml'), 'utf8'))
            .find(candidate => candidate.includes('- name: Install Chromium for PWA Smoke Test'));
        const minutes = Number(step.match(/timeout-minutes: (\d+)/)[1]);
        // Two 3m attempts with a 15s kill grace, plus at most 5s + 60s cleanup.
        assert.ok(2 * (3 * 60 + 15) + 65 < minutes * 60, 'both attempts fit in the step timeout');
    });

    test('the docs-validation setup bounds its Chromium download', () => {
        const setup = readFileSync(join(REPOSITORY, '.propr', 'setup.sh'), 'utf8');
        assert.match(setup, /\n {2}timeout --kill-after=15s 10m npm exec --workspace propr-ui -- playwright install chromium\n/);
    });
});
