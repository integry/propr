/**
 * Authenticated verification of the bundled Agent Tank runtime.
 *
 * The rest of the bundled-mode coverage mocks Docker away, so it can only prove
 * ProPR *asks* the right thing. `scripts/verify-agent-tank-image.sh` is the
 * check that the runtime inside the image answers: real credentials mounted
 * read-only, no provider entrypoint, usage numbers back out of the bundled runtime.
 *
 * These tests drive that script with a fake `docker` on PATH, so they assert two
 * things a real run cannot: that the command it sends is byte-for-byte the one
 * production sends, and that it *fails* on the outcomes that look like success -
 * a present binary, a provider key with no usage, an error-only status.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const VERIFICATION_SCRIPT = 'scripts/verify-agent-tank-image.sh';
const verificationScript = readFileSync(VERIFICATION_SCRIPT, 'utf8');
const bundledRunnerSource = readFileSync(
    'packages/core/src/services/agentTankBundledRunner.ts',
    'utf8',
);
const dockerfile = readFileSync('Dockerfile.agent', 'utf8');
const integrationScript = readFileSync('scripts/integration-test-images.sh', 'utf8');
const smokeScript = readFileSync('scripts/smoke-test-images.sh', 'utf8');
const releaseImageWorkflow = readFileSync('.github/workflows/docker-images.yml', 'utf8');
const prBuildWorkflow = readFileSync('.github/workflows/pr-build-check.yml', 'utf8');
const fixturePath = new URL('./fixtures/agent-tank-verifier-pinned-0.9.11.json', import.meta.url)
    .pathname;
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    cliVersion: string;
    status: Record<string, { name: string; usage: Record<string, unknown> }>;
};

const PINNED_VERSION = fixture.cliVersion;
const CONTAINER_CONFIG_FILE = '/tmp/propr-agent-tank/config.json';

interface VerificationOptions {
    /** Which host credential directories exist for this run. */
    providers?: ('claude' | 'codex' | 'agy')[];
    /** What `agent-tank --version` reports from inside the image. */
    bundledVersion?: 'pinned' | 'older' | 'missing';
    /** What the Agent Tank run prints. */
    usage?: 'canonical' | 'banner' | 'error' | 'empty-usage' | 'missing-provider' | 'unparseable' | 'crash';
    /** What the read-only mount probe reports. */
    mounts?: 'read-only' | 'writable' | 'silent' | 'root-user';
    /** Simulates a mount that was not actually read-only. */
    mutateCredentials?: boolean;
    env?: Record<string, string>;
}

interface VerificationRun {
    status: number | null;
    stdout: string;
    stderr: string;
    /** Every `docker` invocation the script made, in order. */
    dockerRuns: string[][];
}

const CREDENTIAL_DIRECTORIES = {
    claude: { variable: 'CLAUDE_CONFIG_PATH', directory: 'claude', target: '/home/node/.claude' },
    codex: { variable: 'CODEX_CONFIG_PATH', directory: 'codex', target: '/home/node/.codex' },
    agy: { variable: 'ANTIGRAVITY_CONFIG_PATH', directory: 'gemini', target: '/home/node/.gemini' },
} as const;

/**
 * A `docker` that answers the three runs the script makes - version probe,
 * Agent Tank run, read-only mount probe - and records every argument list so the
 * tests can assert on the command production would have received.
 */
const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, \`\${JSON.stringify(args)}\\n\`);
const fixture = JSON.parse(readFileSync(process.env.AGENT_TANK_VERIFIER_FIXTURE, 'utf8'));

if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);

if (args.at(-1) === '--version') {
  const evidence = process.env.FAKE_BUNDLED_VERSION || 'pinned';
  if (evidence === 'missing') {
    process.stderr.write('exec: agent-tank: not found\\n');
    process.exit(127);
  }
  process.stdout.write(\`\${evidence === 'older' ? '0.9.9' : fixture.cliVersion}\\n\`);
  process.exit(0);
}

const script = args[args.indexOf('-c') + 1] || '';
if (script.includes('write-probe')) {
  const evidence = process.env.FAKE_MOUNT_EVIDENCE || 'read-only';
  if (evidence === 'writable') {
    process.stderr.write('writable=/home/node/.claude\\n');
    process.exit(1);
  }
  process.stdout.write(evidence === 'root-user' ? 'user=root\\nread-only-confirmed\\n' : 'user=node\\n');
  if (evidence !== 'silent' && evidence !== 'root-user') process.stdout.write('read-only-confirmed\\n');
  process.exit(0);
}

// The run under test. The mounted providers come from the generated config, so
// the fixture answers exactly the accounts this run inspected.
const configEntry = args.find(arg => arg.startsWith('PROPR_AGENT_TANK_CONFIG='));
const config = JSON.parse(configEntry.slice('PROPR_AGENT_TANK_CONFIG='.length));
const mounted = config.agents.map(agent => agent.provider);

if (process.env.FAKE_MUTATE_CREDENTIALS === '1') {
  const mount = args.find(arg => arg.startsWith('type=bind,'));
  const source = mount.match(/source=([^,]+)/)[1];
  mkdirSync(\`\${source}/projects\`, { recursive: true });
  writeFileSync(\`\${source}/projects/written-by-the-container.json\`, '{}');
}

const evidence = process.env.FAKE_USAGE_EVIDENCE || 'canonical';
if (evidence === 'crash') {
  process.stderr.write('agent-tank: Timeout waiting for usage data\\n');
  process.exit(1);
}
if (evidence === 'unparseable') {
  process.stdout.write('Agent Tank produced no document at all\\n');
  process.exit(0);
}

const status = {};
for (const provider of mounted) {
  if (evidence === 'missing-provider' && provider === 'codex') continue;
  const reported = JSON.parse(JSON.stringify(fixture.status[provider]));
  if (evidence === 'error') {
    reported.usage = {};
    reported.error = 'Timeout waiting for usage data';
  }
  if (evidence === 'empty-usage') reported.usage = {};
  status[provider] = reported;
}

const banner = evidence === 'banner' ? 'Agent Tank starting\\u2026\\n' : '';
process.stdout.write(\`\${banner}\${JSON.stringify(status, null, 2)}\\n\`);
`;

function runVerification(options: VerificationOptions = {}): VerificationRun {
    const providers = options.providers ?? ['claude', 'codex', 'agy'];
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'propr-agent-tank-script-test.'));
    const binDirectory = join(fixtureRoot, 'bin');
    mkdirSync(binDirectory);

    const fakeDockerPath = join(binDirectory, 'docker');
    writeFileSync(fakeDockerPath, FAKE_DOCKER);
    chmodSync(fakeDockerPath, 0o755);

    const dockerLog = join(fixtureRoot, 'docker-runs.jsonl');
    writeFileSync(dockerLog, '');

    const credentialEnv: Record<string, string> = {};
    for (const [provider, descriptor] of Object.entries(CREDENTIAL_DIRECTORIES)) {
        const path = join(fixtureRoot, descriptor.directory);
        if (providers.includes(provider as keyof typeof CREDENTIAL_DIRECTORIES)) {
            mkdirSync(path);
            // A credential home with something in it, so the immutability
            // manifest has real content to compare before and after the run.
            writeFileSync(join(path, '.credentials.json'), '{"fixture":true}');
        }
        credentialEnv[descriptor.variable] = path;
    }

    try {
        const result = spawnSync('bash', [VERIFICATION_SCRIPT], {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
                ...process.env,
                ...credentialEnv,
                AGENT_TAG: 'fake-propr-agent',
                AGENT_TANK_VERIFIER_FIXTURE: fixturePath,
                FAKE_DOCKER_LOG: dockerLog,
                FAKE_BUNDLED_VERSION: options.bundledVersion ?? 'pinned',
                FAKE_USAGE_EVIDENCE: options.usage ?? 'canonical',
                FAKE_MOUNT_EVIDENCE: options.mounts ?? 'read-only',
                FAKE_MUTATE_CREDENTIALS: options.mutateCredentials ? '1' : '0',
                PATH: `${binDirectory}:${process.env.PATH}`,
                ...options.env,
            },
        });

        const dockerRuns = readFileSync(dockerLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as string[]);

        return { status: result.status, stdout: result.stdout, stderr: result.stderr, dockerRuns };
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

/** The Agent Tank run itself: the one that execs a bootstrap with the config. */
function agentTankRun(runs: string[][]): string[] {
    const run = runs.find(args => {
        const script = args[args.indexOf('-c') + 1] ?? '';
        return script.includes('--once --json --config');
    });
    assert.ok(run, 'the script never ran Agent Tank');
    return run;
}

function containerCommand(args: string[]): string[] {
    return args.slice(args.indexOf('fake-propr-agent') + 1);
}

function generatedConfig(args: string[]): { agents: unknown[]; dockerAccess: boolean } {
    const entry = args.find(arg => arg.startsWith('PROPR_AGENT_TANK_CONFIG='));
    assert.ok(entry, 'the run carries no generated Agent Tank config');
    return JSON.parse(entry.slice('PROPR_AGENT_TANK_CONFIG='.length));
}

function mountSpecs(args: string[]): string[] {
    return args.filter((_arg, index) => args[index - 1] === '--mount');
}

/**
 * The bootstrap the production runner sends, rebuilt from its source so a change
 * there fails here instead of quietly making this script verify something else.
 */
function productionBootstrap(): string {
    const envVar = bundledRunnerSource.match(/const CONFIG_ENV_VAR = '([^']+)'/)?.[1];
    assert.ok(envVar, 'CONFIG_ENV_VAR is no longer a literal in the bundled runner');
    const block = bundledRunnerSource.match(/const CONFIG_BOOTSTRAP = \[([\s\S]*?)\]\.join\('; '\)/)?.[1];
    assert.ok(block, 'CONFIG_BOOTSTRAP is no longer a joined array in the bundled runner');
    const parts = [...block.matchAll(/^\s*[`'](.*)[`'],$/gm)].map(match => match[1]);
    assert.ok(parts.length >= 2, 'could not read the CONFIG_BOOTSTRAP parts');
    return parts.join('; ').replaceAll('${CONFIG_ENV_VAR}', envVar);
}

test('the authenticated run reproduces the production bundled command exactly', () => {
    const bootstrap = productionBootstrap();

    assert.ok(
        verificationScript.includes(`BUNDLED_BOOTSTRAP='${bootstrap}'`),
        `the verification script must exec the production bootstrap:\n${bootstrap}`,
    );
    // Same container config path, so the run writes the config where production
    // writes it rather than somewhere only this script would look.
    const productionConfigFile = bundledRunnerSource.match(
        /const CONTAINER_CONFIG_FILE = '([^']+)'/,
    )?.[1];
    assert.equal(productionConfigFile, CONTAINER_CONFIG_FILE);
    assert.ok(verificationScript.includes(`CONTAINER_CONFIG_FILE=${CONTAINER_CONFIG_FILE}`));

    // The script generates the config itself (it has no ProPR runtime to call),
    // so an upstream schema change has to surface here rather than in a release
    // run that hands Agent Tank a config it no longer understands.
    const builder = bundledRunnerSource.match(
        /export function buildBundledAgentTankConfig[\s\S]*?\n}/,
    )?.[0];
    assert.ok(builder, 'buildBundledAgentTankConfig is no longer a standalone function');
    for (const field of [
        'provider: entry.provider',
        'id: entry.provider',
        'configPath: entry.configPath',
        'dockerAccess: false',
    ]) {
        assert.ok(
            builder.includes(field),
            `buildBundledAgentTankConfig no longer sets \`${field}\`; update ${VERIFICATION_SCRIPT}`,
        );
    }
});

test('an authenticated image run reports usage for every mounted provider', () => {
    const result = runVerification();

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`image ships the pinned Agent Tank ${PINNED_VERSION}`));
    // Usage numbers, not a present binary: this is the evidence the mocked
    // coverage cannot produce.
    assert.match(result.stdout, /claude: session\.percent=42, weeklyAll\.percent=31/);
    assert.match(result.stdout, /codex: fiveHour\.percentUsed=9/);
    assert.match(result.stdout, /agy: models\[Gemini 3\.8 Flash\]\.percentUsed=16/);
    assert.match(result.stdout, /every mounted provider returned usage through the bundled runtime/);
    assert.match(result.stdout, /credential mounts are read-only and no provider entrypoint ran/);
    assert.match(result.stdout, /host credential directories are byte-for-byte unchanged/);
    assert.match(result.stdout, new RegExp(`verification passed \\(bundled runtime, version ${PINNED_VERSION}\\)`));
});

test('the run mounts credentials read-only and bypasses every provider entrypoint', () => {
    const result = runVerification();
    const args = agentTankRun(result.dockerRuns);

    for (const descriptor of Object.values(CREDENTIAL_DIRECTORIES)) {
        const spec = mountSpecs(args).find(mount => mount.includes(`target=${descriptor.target}`));
        assert.ok(spec, `no mount for ${descriptor.target}`);
        assert.match(spec, /^type=bind,source=\/.+,readonly$/);
    }
    // PROPR_AGENT_TYPE=agent-tank is what keeps the image entrypoint from running
    // a per-provider entrypoint (and its credential ownership repair) over a
    // read-only mount.
    assert.ok(args.includes('PROPR_AGENT_TYPE=agent-tank'));
    assert.equal(args.some(arg => arg === '--entrypoint'), false);
    assert.equal(args.some(arg => arg.includes('-entrypoint.sh')), false);

    const command = containerCommand(args);
    assert.equal(command[0], 'sh');
    assert.equal(command[1], '-c');
    assert.deepEqual(command.slice(-2), ['propr-agent-tank', CONTAINER_CONFIG_FILE]);
    assert.deepEqual(generatedConfig(args), {
        agents: [
            { provider: 'claude', id: 'claude', configPath: '/home/node/.claude' },
            { provider: 'codex', id: 'codex', configPath: '/home/node/.codex' },
            { provider: 'agy', id: 'agy', configPath: '/home/node/.gemini' },
        ],
        dockerAccess: false,
    });
});

test('only the providers with host credentials are inspected', () => {
    const result = runVerification({ providers: ['codex'] });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(generatedConfig(agentTankRun(result.dockerRuns)).agents, [
        { provider: 'codex', id: 'codex', configPath: '/home/node/.codex' },
    ]);
    assert.doesNotMatch(result.stdout, /claude:/);
});

test('a requested provider subset is honoured, and a missing one is an error not a skip', () => {
    // A release runner is only authenticated for some providers, so the caller
    // names them - and naming one whose credentials are absent has to fail,
    // otherwise the run silently verifies nothing.
    const restricted = runVerification({ env: { AGENT_TANK_PROVIDERS: 'agy' } });
    assert.equal(restricted.status, 0, `stdout:\n${restricted.stdout}\nstderr:\n${restricted.stderr}`);
    assert.deepEqual(generatedConfig(agentTankRun(restricted.dockerRuns)).agents, [
        { provider: 'agy', id: 'agy', configPath: '/home/node/.gemini' },
    ]);

    const missing = runVerification({ providers: ['agy'], env: { AGENT_TANK_PROVIDERS: 'claude agy' } });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Provider claude was requested but has no credentials/);

    const unsupported = runVerification({ env: { AGENT_TANK_PROVIDERS: 'opencode' } });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /AGENT_TANK_PROVIDERS must list claude, codex, or agy/);
});

test('an unpublished pin is verified by building the public repository at that ref', () => {
    for (const bundledVersion of ['older', 'missing'] as const) {
        const result = runVerification({ bundledVersion });

        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.ok(result.stdout.includes(`building the pinned ref v${PINNED_VERSION} from https://github.com/integry/agent-tank.git`));
        assert.match(result.stdout, new RegExp(`verification passed \\(source runtime, version ${PINNED_VERSION}\\)`));

        const args = agentTankRun(result.dockerRuns);
        assert.ok(args.includes(`AGENT_TANK_GIT_REF=v${PINNED_VERSION}`));
        assert.ok(args.includes('AGENT_TANK_REPO_URL=https://github.com/integry/agent-tank.git'));
        assert.ok(args.includes(`AGENT_TANK_VERSION=${PINNED_VERSION}`));

        const script = containerCommand(args)[2];
        assert.match(script, /git clone --quiet --depth 1 --branch "\$AGENT_TANK_GIT_REF" "\$AGENT_TANK_REPO_URL"/);
        // The clone is only evidence about the pin if the built tree is checked
        // against it, and npm chatter must stay off the JSON document on stdout.
        assert.match(script, /built_version" != "\$AGENT_TANK_VERSION"/);
        assert.match(script, /AGENT_TANK_GIT_COMMIT/);
        assert.match(script, /npm install --omit=dev --no-audit --no-fund --loglevel=error >&2/);
        assert.match(script, /exec node bin\/agent-tank\.js --once --json --config "\$1"/);
    }
});

test('requesting the bundled runtime refuses an image that does not ship the pin', () => {
    const result = runVerification({ bundledVersion: 'older', env: { AGENT_TANK_RUNTIME: 'bundled' } });

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        new RegExp(`Image ships agent-tank '0\\.9\\.9', expected the pinned ${PINNED_VERSION}`),
    );
    assert.equal(
        result.dockerRuns.some(args => (args[args.indexOf('-c') + 1] ?? '').includes('--once')),
        false,
        'a mismatched image must not be treated as verified',
    );
});

test('a present binary that returns no usage fails the verification', async t => {
    const cases = [
        ['error-only status', 'error', /reported an error for provider claude: Timeout waiting for usage data/],
        ['empty usage', 'empty-usage', /reported no usage numbers for provider claude/],
        ['missing provider', 'missing-provider', /reported nothing for provider codex/],
        ['unparseable output', 'unparseable', /produced unparseable JSON|produced no JSON document/],
        ['failed run', 'crash', /bundled Agent Tank run failed inside fake-propr-agent/],
    ] as const;

    for (const [name, usage, expectedError] of cases) {
        await t.test(name, () => {
            const result = runVerification({ usage });

            assert.notEqual(result.status, 0, `${name} must not pass`);
            assert.match(result.stderr, expectedError);
        });
    }
});

test('leading banner output is tolerated exactly as the production parser tolerates it', () => {
    const result = runVerification({ usage: 'banner' });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /claude: session\.percent=42/);
});

test('a credential mount that is not read-only fails the verification', async t => {
    const cases = [
        ['writable mount', { mounts: 'writable' as const }, /a mounted credential directory was writable inside the container/],
        ['no verdict', { mounts: 'silent' as const }, /read-only mount probe produced no verdict/],
        ['privileged user', { mounts: 'root-user' as const }, /the usage probe ran as user=root, expected user=node/],
        ['credentials changed', { mutateCredentials: true }, /changed during the usage probe/],
    ] as const;

    for (const [name, options, expectedError] of cases) {
        await t.test(name, () => {
            const result = runVerification(options);

            assert.notEqual(result.status, 0, `${name} must not pass`);
            assert.match(result.stderr, expectedError);
        });
    }
});

test('an unauthenticated host is reported rather than passing with nothing to inspect', () => {
    const result = runVerification({ providers: [] });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No authenticated agent CLI credentials found/);
    assert.equal(result.dockerRuns.some(args => args.includes('--mount')), false);
});

test('the verification pin follows the Dockerfile pin and the agent runtime container paths', () => {
    const dockerfilePin = dockerfile.match(/^ARG AGENT_TANK_CLI_VERSION=([^\s]+)$/m)?.[1];
    assert.equal(
        dockerfilePin,
        PINNED_VERSION,
        'bumping AGENT_TANK_CLI_VERSION needs a refreshed verifier fixture',
    );
    assert.match(
        verificationScript,
        /sed -n 's\/\^ARG AGENT_TANK_CLI_VERSION=/,
        'the script must read the pin out of Dockerfile.agent rather than duplicating it',
    );

    const containerPaths = readFileSync('packages/core/src/agents/types.ts', 'utf8');
    for (const target of Object.values(CREDENTIAL_DIRECTORIES).map(entry => entry.target)) {
        assert.ok(containerPaths.includes(`'${target}'`), `${target} is not a CONTAINER_CONFIG_PATHS value`);
        assert.ok(verificationScript.includes(target));
    }
});

test('the authenticated verification is wired into image integration, release, and lint', () => {
    assert.ok(existsSync(VERIFICATION_SCRIPT));
    assert.match(integrationScript, /\.\/scripts\/verify-agent-tank-image\.sh/);
    // Release publication must not ship an agent image whose bundled Agent Tank
    // was never asked for real usage.
    assert.match(
        releaseImageWorkflow,
        /Smoke test Docker Hub images[\s\S]+Verify authenticated bundled Agent Tank usage from packaged agent image[\s\S]+AGENT_TAG: \$\{\{ env\.DOCKERHUB_NS \}\}\/agent:\$\{\{ steps\.version\.outputs\.version \}\}[\s\S]+\.\/scripts\/verify-agent-tank-image\.sh[\s\S]+Stage, preflight, and publish smoke-tested images/,
    );
    assert.match(prBuildWorkflow, /scripts\/verify-agent-tank-image\.sh/);
});

test('the unauthenticated image smoke test covers the bundled Agent Tank runtime too', () => {
    // No credentials needed for these two, so they run on every image build: the
    // CLI has to be on PATH, and the entrypoint's agent-tank branch has to run it
    // without routing through a provider entrypoint.
    assert.match(smokeScript, /for executable in [^\n]*\bagent-tank\b/);
    assert.match(
        smokeScript,
        /docker run --rm --network none -e PROPR_AGENT_TYPE=agent-tank "\$AGENT_TAG" agent-tank --version/,
    );
});
