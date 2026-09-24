import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const CI_REDIS = join(REPOSITORY, 'scripts', 'ci-redis.sh');
const CI_RUNNER_EVIDENCE = join(REPOSITORY, 'scripts', 'ci-runner-evidence.sh');

const scratch = mkdtempSync(join(tmpdir(), 'propr-ci-runner-routing-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let scratchCounter = 0;
const freshDirectory = (name) => {
    scratchCounter += 1;
    const directory = join(scratch, `${String(scratchCounter).padStart(2, '0')}-${name}`);
    mkdirSync(directory, { recursive: true });
    return directory;
};
const escapeRegExp = text => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const readWorkflow = name => readFileSync(join(REPOSITORY, '.github', 'workflows', name), 'utf8');

function jobBlock(workflow, job) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.ok(start >= 0, `job ${job} exists`);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][a-z0-9_-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
}

function jobNames(workflow) {
    const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
    return [...jobs.matchAll(/\n {2}([a-z][a-z0-9_-]*):\n/g)].map(match => match[1]);
}

function extractRunBlock(block, stepName) {
    const lines = block.slice(block.indexOf(`- name: ${stepName}`)).split('\n');
    const runLine = lines.findIndex(line => line.trim() === 'run: |');
    assert.ok(runLine > 0, `${stepName} must use a run block`);
    const indent = lines[runLine + 1].match(/^ */)[0].length;
    const result = [];
    for (const line of lines.slice(runLine + 1)) {
        if (line.trim() !== '' && line.match(/^ */)[0].length < indent) break;
        result.push(line.slice(indent));
    }
    return result.join('\n');
}

function runFailureComment(directory, comment, environment = {}) {
    const lines = comment.split('\n');
    const start = lines.findIndex(line => /^\s+script: \|$/.test(line)) + 1;
    const indent = lines[start].match(/^\s*/)[0];
    const end = lines.findIndex((line, index) => index > start && line.trim() !== '' && !line.startsWith(indent));
    const script = lines.slice(start, end === -1 ? undefined : end).map(line => line.slice(indent.length)).join('\n');
    writeFileSync(join(directory, 'harness.cjs'), `
        let body;
        const github = { rest: { issues: { createComment: async request => { body = request.body; } } } };
        const context = { runId: 1, repo: { owner: 'o', repo: 'r' }, issue: { number: 1 } };
        new (Object.getPrototypeOf(async () => {}).constructor)('require', 'github', 'context', process.argv[2])(require, github, context)
            .then(() => process.stdout.write(body));
    `);
    const result = spawnSync(process.execPath, ['harness.cjs', script], {
        cwd: directory,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, PROPR_TEST_SHARD_COUNT: '4', COVERAGE_RESULT: 'failure', SHARD_RESULT: 'failure', ...environment },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

// Minimal Docker CLI double for scripts/ci-redis.sh: containers are files
// holding their labels, and every removal is logged.
function createFakeDocker() {
    const root = freshDirectory('fake-docker');
    const bin = join(root, 'bin');
    const state = join(root, 'containers');
    mkdirSync(bin);
    mkdirSync(state);
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
state=${JSON.stringify(state)}
command="$1"; shift
case "$command" in
  run)
    arguments=("$@"); name=""; labels=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --label) labels+=("$2"); shift 2 ;;
        --publish|--health-cmd|--health-interval|--health-timeout|--health-retries) shift 2 ;;
        --*) shift ;;
        *) shift ;;
      esac
    done
    [[ ! -e "$state/$name" ]] || { echo "Conflict: $name" >&2; exit 125; }
    printf '%s\\n' "\${labels[@]}" > "$state/$name"
    printf '%s\\n' "\${arguments[@]}" > "$state/.args-$name"
    echo "run $name" >> "$state/.log"
    publish=""
    for ((i=0; i<\${#arguments[@]}; i++)); do
      if [[ "\${arguments[i]}" == --publish ]]; then publish="\${arguments[i+1]}"; fi
    done
    echo "$publish" >> "$state/.ports-$name"
    attempts=$(wc -l < "$state/.ports-$name")
    if (( attempts <= \${FAKE_RUN_FAILURES:-0} )); then
      if [[ -n "\${FAKE_FOREIGN_OWNER:-}" ]]; then
        sed -i 's/propr.ci.redis.job=.*/propr.ci.redis.job=foreign/' "$state/$name"
      fi
      echo "\${FAKE_RUN_ERROR:-error while calling RootlessKit PortManager.AddPort(): listen tcp4 127.0.0.1:32768: bind: address already in use}" >&2
      exit 125
    fi
    ;;
  inspect)
    name="\${@: -1}"; name="\${name#id-}"
    [[ -e "$state/$name" ]] || exit 1
    if [[ "\${1:-}" == --format ]]; then
      case "$2" in
        '{{.Id}}') echo "id-$name" ;;
        '{{.State.Health.Status}}') echo healthy ;;
        *) key="$(printf '%s' "$2" | cut -d'"' -f2)"; sed -n "s/^$key=//p" "$state/$name" ;;
      esac
    fi
    ;;
  rm)
    name="\${@: -1}"; [[ "$name" == id-* ]] || exit 9; name="\${name#id-}"
    rm -f "$state/$name"
    echo "rm $name" >> "$state/.log"
    ;;
  port)
    publish=$(tail -1 "$state/.ports-$1")
    if [[ "$publish" == 127.0.0.1::6379 ]]; then
      printf '127.0.0.1:%s\\n' "$(( $(printf '%s' "$1" | cksum | cut -d' ' -f1) % 20000 + 20000 ))"
    else
      echo "\${publish%:6379}"
    fi
    ;;
  ps)
    filters=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --filter) filters+=("\${2#label=}"); shift 2 ;;
        --format) shift 2 ;;
        *) shift ;;
      esac
    done
    for file in "$state"/*; do
      [[ -e "$file" ]] || continue
      matched=true
      for filter in "\${filters[@]}"; do
        grep -qxF -- "$filter" "$file" || matched=false
      done
      if $matched; then basename "$file"; fi
    done
    ;;
  logs) ;;
  *) echo "unexpected docker $command" >&2; exit 1 ;;
esac
`);
    chmodSync(join(bin, 'docker'), 0o755);
    const containers = () => readdirSync(state).filter(name => !name.startsWith('.')).sort();
    const removals = () => (existsSync(join(state, '.log')) ? readFileSync(join(state, '.log'), 'utf8') : '')
        .split('\n').filter(line => line.startsWith('rm ')).map(line => line.slice(3));
    const runArguments = name => readFileSync(join(state, `.args-${name}`), 'utf8').trim().split('\n');
    const publishedPorts = name => readFileSync(join(state, `.ports-${name}`), 'utf8').trim().split('\n');
    return { bin, state, containers, removals, runArguments, publishedPorts };
}

function runRedis(docker, action, env) {
    return spawnSync('bash', [CI_REDIS, action], {
        encoding: 'utf8',
        env: {
            PATH: `${docker.bin}:${process.env.PATH}`,
            GITHUB_RUN_ID: '777',
            GITHUB_JOB: 'shard',
            GITHUB_RUN_ATTEMPT: '1',
            CI_REDIS_STATE_DIR: docker.state.replace(/containers$/, 'redis-state'),
            ...env,
        },
    });
}

function redisName(docker, env = {}) {
    const result = runRedis(docker, 'name', env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^propr-ci-redis-[a-f0-9]{64}$/);
    return result.stdout.trim();
}

function startRedis(docker, env) {
    const result = runRedis(docker, 'start', env);
    assert.equal(result.status, 0, result.stderr);
    return redisName(docker, env);
}

describe('scripts/ci-redis.sh shared-host isolation', () => {
    test('recovers a RootlessKit host port collision and exports the successful mapping', () => {
        const docker = createFakeDocker();
        const other = startRedis(docker, { CI_REDIS_INSTANCE: 'shard-1' });
        const file = join(docker.state, '../shard-2.env');
        const env = { CI_REDIS_INSTANCE: 'shard-2', CI_REDIS_ENV_FILE: file, FAKE_RUN_FAILURES: '2' };
        const name = startRedis(docker, env);
        const ports = docker.publishedPorts(name);
        assert.equal(ports.length, 3);
        assert.equal(ports[0], '127.0.0.1::6379');
        assert.notEqual(ports[1], ports[2]);
        for (const mapping of ports.slice(1)) {
            assert.match(mapping, /^127\.0\.0\.1:\d+:6379$/);
            const port = Number(mapping.split(':')[1]);
            assert.ok(port >= 49152 && port <= 65535);
        }
        assert.deepEqual(docker.removals(), [name, name]);
        assert.deepEqual(docker.containers(), [other, name].sort());
        assert.match(readFileSync(file, 'utf8'), new RegExp(`^REDIS_PORT=${ports[2].split(':')[1]}$`, 'm'));
        assert.equal(runRedis(docker, 'stop', env).status, 0);
        assert.deepEqual(docker.containers(), [other]);
    });

    test('bounds port conflict retries, cleans failed containers and exports no connection settings', () => {
        const docker = createFakeDocker();
        const file = join(docker.state, '../failed.env');
        const env = { CI_REDIS_ENV_FILE: file, FAKE_RUN_FAILURES: '99' };
        const result = runRedis(docker, 'start', env);
        const name = redisName(docker, env);
        assert.equal(result.status, 125, result.stderr);
        assert.match(result.stderr, /Redis port allocation failed after 5 attempts/);
        assert.equal(docker.publishedPorts(name).length, 5);
        assert.equal(new Set(docker.publishedPorts(name)).size, 5);
        assert.equal(docker.removals().length, 5);
        assert.deepEqual(docker.containers(), []);
        assert.equal(existsSync(file), false);
        assert.equal(existsSync(join(docker.state, '../redis-state', `${name}.name`)), false);
    });

    test('does not retry unrelated Docker failures or remove a foreign container during retry cleanup', () => {
        for (const extra of [{ FAKE_RUN_ERROR: 'OCI runtime create failed: permission denied' }, { FAKE_FOREIGN_OWNER: 'true' }]) {
            const docker = createFakeDocker();
            const env = { FAKE_RUN_FAILURES: '1', ...extra };
            const result = runRedis(docker, 'start', env);
            const name = redisName(docker, env);
            assert.notEqual(result.status, 0);
            assert.equal(docker.publishedPorts(name).length, 1);
            if (extra.FAKE_FOREIGN_OWNER) {
                assert.match(result.stderr, /Refusing to remove/);
                assert.deepEqual(docker.removals(), []);
                assert.deepEqual(docker.containers(), [name]);
            } else {
                assert.equal(result.status, 125);
                assert.match(result.stderr, /OCI runtime create failed/);
                assert.deepEqual(docker.containers(), []);
            }
        }
    });

    test('gives every matrix shard its own container, port and connection file', () => {
        const docker = createFakeDocker();
        const settings = [];
        for (const instance of ['shard-1', 'shard-2']) {
            const file = join(docker.state, `../${instance}.env`);
            const name = startRedis(docker, { CI_REDIS_INSTANCE: instance, CI_REDIS_ENV_FILE: file });
            settings.push(Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map(line => line.split('='))));
            assert.equal(settings.at(-1).REDIS_CONTAINER_NAME, name);
            assert.equal(settings.at(-1).PROPR_TEST_REDIS_ISOLATION, 'flush');
        }
        assert.notEqual(settings[0].REDIS_PORT, settings[1].REDIS_PORT);
        assert.equal(docker.containers().length, 2);
        assert.equal(runRedis(docker, 'stop', { CI_REDIS_INSTANCE: 'shard-1' }).status, 0);
        assert.deepEqual(docker.containers(), [settings[1].REDIS_CONTAINER_NAME]);
        assert.deepEqual(docker.removals(), [settings[0].REDIS_CONTAINER_NAME]);
    });

    test('recovers only older attempts of this run, job and instance', () => {
        const docker = createFakeDocker();
        const own = { CI_REDIS_INSTANCE: 'shard-1' };
        const previous = startRedis(docker, own);
        const preserved = [
            { CI_REDIS_INSTANCE: 'shard-2' },
            { ...own, GITHUB_RUN_ID: '778' },
            { ...own, GITHUB_JOB: 'other' },
        ].map(env => startRedis(docker, env));
        const current = startRedis(docker, { ...own, GITHUB_RUN_ATTEMPT: '2' });
        assert.deepEqual(docker.removals(), [previous]);
        assert.deepEqual(docker.containers(), [...preserved, current].sort());
        // Delayed old-attempt start/stop must also leave the new attempt alone.
        startRedis(docker, own);
        assert.ok(docker.containers().includes(current));
        assert.equal(runRedis(docker, 'stop', own).status, 0);
        assert.deepEqual(docker.containers(), [...preserved, current].sort());
    });

    test('keeps existing callers without an instance and exports to GITHUB_ENV', () => {
        const docker = createFakeDocker();
        const file = join(docker.state, '../github.env');
        const env = { GITHUB_JOB: 'e2e-tests', GITHUB_ENV: file };
        const name = startRedis(docker, env);
        assert.deepEqual(docker.containers(), [name]);
        assert.match(readFileSync(file, 'utf8'), /^REDIS_PORT=\d+$/m);
        assert.equal(runRedis(docker, 'stop', env).status, 0);
        assert.deepEqual(docker.containers(), []);
    });

    for (const other of [{}, { GITHUB_JOB: 'shard-default' }]) {
        for (const reverse of [false, true]) {
            test(`shard/default coexists with ${other.GITHUB_JOB || 'shard'}/omitted; reverse=${reverse}`, () => {
                const docker = createFakeDocker();
                const owners = [{ CI_REDIS_INSTANCE: 'default' }, other];
                if (reverse) owners.reverse();
                const names = owners.map(env => startRedis(docker, env));
                assert.notEqual(names[0], names[1]);
                assert.deepEqual(docker.containers(), [...names].sort());
                assert.deepEqual(docker.removals(), []);
                assert.equal(runRedis(docker, 'stop', owners[0]).status, 0);
                assert.deepEqual(docker.containers(), [names[1]]);
                assert.equal(runRedis(docker, 'stop', owners[1]).status, 0);
                assert.deepEqual(docker.containers(), []);
            });
        }
    }

    test('does not alias field boundaries, punctuation, empty instances or attempts', () => {
        const docker = createFakeDocker();
        const owners = [
            { GITHUB_RUN_ID: 'a-b', GITHUB_JOB: 'c' },
            { GITHUB_RUN_ID: 'a', GITHUB_JOB: 'b-c' },
            { GITHUB_JOB: 'shard/a' }, { GITHUB_JOB: 'shard-a' },
            {}, { CI_REDIS_INSTANCE: 'default' }, { GITHUB_RUN_ATTEMPT: '2' },
        ];
        assert.equal(new Set(owners.map(env => redisName(docker, env))).size, owners.length);
    });

    for (const label of ['propr.ci.redis', 'propr.ci.redis.run', 'propr.ci.redis.job', 'propr.ci.redis.instance', 'propr.ci.redis.attempt']) {
        for (const action of ['start', 'stop']) {
            test(`${action} refuses a matching name with a foreign ${label} label`, () => {
                const docker = createFakeDocker();
                const name = startRedis(docker, {});
                const file = join(docker.state, name);
                const labels = readFileSync(file, 'utf8').split('\n').map(line => line.startsWith(`${label}=`) ? `${label}=${label.endsWith('attempt') ? '2' : 'foreign'}` : line).join('\n');
                writeFileSync(file, labels);
                const result = runRedis(docker, action, {});
                assert.equal(result.status, 1, result.stderr);
                assert.match(result.stderr, /Refusing to remove/);
                assert.deepEqual(docker.containers(), [name]);
                assert.deepEqual(docker.removals(), []);
            });
        }
    }

    test('rechecks ownership of previous-attempt candidates and rejects tampered state files', () => {
        const docker = createFakeDocker();
        const name = startRedis(docker, {});
        const file = join(docker.state, name);
        writeFileSync(file, readFileSync(file, 'utf8').replace('propr.ci.redis=true', 'propr.ci.redis=false'));
        assert.equal(runRedis(docker, 'start', { GITHUB_RUN_ATTEMPT: '2' }).status, 1);
        assert.deepEqual(docker.removals(), []);
        const other = startRedis(docker, { GITHUB_JOB: 'other' });
        writeFileSync(join(docker.state, '../redis-state', `${other}.name`), name);
        assert.equal(runRedis(docker, 'stop', { GITHUB_JOB: 'other' }).status, 1);
        assert.deepEqual(docker.containers(), [name, other].sort());
    });

    test('rejects invalid instances, attempts and Docker limits', () => {
        const docker = createFakeDocker();
        for (const env of [
            ...['shard/1', 'shard 1', '-shard', 'a'.repeat(64)].map(CI_REDIS_INSTANCE => ({ CI_REDIS_INSTANCE })),
            { GITHUB_RUN_ATTEMPT: '0' }, { CI_REDIS_MEMORY: 'unlimited' },
            { CI_REDIS_MEMORY: '0m' }, { CI_REDIS_CPUS: '-1' }, { CI_REDIS_PIDS_LIMIT: '0' },
        ]) assert.equal(runRedis(docker, 'start', env).status, 2, JSON.stringify(env));
        assert.deepEqual(docker.containers(), []);
    });

    test('bounds Redis outside the runner cgroup and binds only a dynamic loopback port', () => {
        const docker = createFakeDocker();
        const args = docker.runArguments(startRedis(docker, {}));
        const option = name => args[args.indexOf(name) + 1];
        assert.equal(option('--memory'), '512m');
        assert.equal(option('--memory-swap'), '512m');
        assert.equal(option('--cpus'), '1');
        assert.equal(option('--pids-limit'), '64');
        assert.equal(option('--publish'), '127.0.0.1::6379');
        const overridden = docker.runArguments(startRedis(docker, { CI_REDIS_INSTANCE: 'limits', CI_REDIS_MEMORY: '1g', CI_REDIS_CPUS: '0.5' }));
        assert.equal(overridden[overridden.indexOf('--memory') + 1], '1g');
        assert.equal(overridden[overridden.indexOf('--cpus') + 1], '0.5');
    });
});
describe('scripts/ci-runner-evidence.sh', () => {
    test('records the runner name, user and cgroup limits without changing anything', () => {
        const summary = join(freshDirectory('runner-evidence'), 'summary.md');
        const result = spawnSync('bash', [CI_RUNNER_EVIDENCE], {
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH,
                GITHUB_JOB: 'shard',
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_STEP_SUMMARY: summary,
                PROPR_EVIDENCE_LABEL: 'shard 3/4',
                RUNNER_NAME: 'gitfix-propr-3',
                RUNNER_ENVIRONMENT: 'self-hosted',
            },
        });
        assert.equal(result.status, 0, result.stderr);
        const report = readFileSync(summary, 'utf8');
        assert.equal(report.trim(), result.stdout.trim());
        assert.match(report, /### Runner placement: shard \(shard 3\/4\)/);
        assert.match(report, /\| Runner name \| `gitfix-propr-3` \|/);
        assert.match(report, /\| Runner environment \| `self-hosted` \|/);
        assert.match(report, new RegExp(`\\| User \\(uid\\) \\| \`[^\`]+\` \\(\`${process.getuid()}\`\\) \\|`));
        assert.match(report, /\| Run attempt \| `2` \|/);
        for (const limit of ['cpu.max', 'memory.high', 'memory.max']) assert.match(report, new RegExp(`\\| ${escapeRegExp(limit)} \\| \`[^\`]+\` \\|`));
    });
});

describe('PR check routing', () => {
    const fullSuite = readWorkflow('pr-test-on-label.yml');
    const buildCheck = readWorkflow('pr-build-check.yml');
    const routedJobs = () => [
        ['pr-test-on-label.yml shard', jobBlock(fullSuite, 'shard')],
        ['pr-test-on-label.yml docs', jobBlock(fullSuite, 'docs')],
        ...['validate', 'cli-node-matrix'].map(job => [`pr-build-check.yml ${job}`, jobBlock(buildCheck, job)]),
        ['cli-node-compatibility.yml project-options', jobBlock(readWorkflow('cli-node-compatibility.yml'), 'project-options')],
    ];

    test('routes compatible work only after explicit activation, with forks and untrusted dispatches hosted', () => {
        const expressions = routedJobs().map(([name, block]) => {
            const expression = block.match(/runs-on: \$\{\{ (fromJSON\(.+\)) \}\}/)?.[1];
            assert.ok(expression, `${name} has gated routing`);
            return expression;
        });
        for (const expression of expressions) {
            assert.doesNotMatch(expression, /PROPR_SELF_HOSTED_PR_ACCESS_VERIFIED|PROPR_SELF_HOSTED_PR_CHECKS|"propr"/);
        }
        assert.equal(new Set(expressions).size, 1, 'all routing uses the same conditions');
        const evaluate = new Function('vars', 'github', 'fromJSON', 'format', `return ${expressions[0]}`);
        const github = {
            actor: 'maintainer', repository: 'integry/propr', event_name: 'pull_request', ref: 'refs/pull/2466/merge',
            event: { repository: { default_branch: 'main' }, pull_request: { user: { login: 'maintainer' }, head: { repo: { full_name: 'integry/propr' } } } },
        };
        const enabled = { PROPR_ROOTLESS_PR_CHECKS: 'true' };
        const cases = [
            [enabled, github, true],
            [{}, github, false],
            [{ PROPR_SELF_HOSTED_PR_CHECKS: 'true' }, github, false],
            [{ PROPR_ROOTLESS_PR_CHECKS: 'false' }, github, false],
            [{ PROPR_ROOTLESS_PR_CHECKS: '' }, github, false],
            [{ PROPR_ROOTLESS_PR_CHECKS: '1' }, github, false],
            [{ PROPR_SELF_HOSTED_PR_ACCESS_VERIFIED: 'true', PROPR_SELF_HOSTED_PR_CHECKS: 'true' }, github, false],
            [{ ...enabled, PROPR_SELF_HOSTED_PR_ACCESS_VERIFIED: 'false' }, github, true],
            [{ PROPR_SELF_HOSTED_PR_ACCESS_VERIFIED: 'false' }, github, false],
            [enabled, { ...github, actor: 'dependabot[bot]' }, false],
            [enabled, { ...github, event: { ...github.event, pull_request: { ...github.event.pull_request, user: { login: 'dependabot[bot]' } } } }, false],
            [enabled, { ...github, event: { pull_request: { user: { login: 'contributor' }, head: { repo: { full_name: 'fork/propr' } } } } }, false],
            [enabled, { ...github, event_name: 'workflow_dispatch', ref: 'refs/heads/main' }, true],
            [enabled, { ...github, event_name: 'workflow_dispatch', ref: 'refs/heads/unreviewed' }, false],
            [enabled, { ...github, event_name: 'push' }, false],
            [enabled, { ...github, event_name: 'pull_request_target' }, false],
            [enabled, { ...github, event_name: 'schedule' }, false],
        ];
        for (const [vars, context, selfHosted] of cases) {
            assert.deepEqual(evaluate(vars, context, JSON.parse, (pattern, value) => pattern.replace('{0}', value)),
                selfHosted ? ['self-hosted', 'Linux', 'X64', 'propr-rootless'] : ['ubuntu-latest'], JSON.stringify({ vars, context }));
        }
    });

    test('keeps four independent shard jobs and a separate docs job', () => {
        assert.deepEqual(jobNames(fullSuite), ['classify', 'shard', 'docs', 'native-electron', 'test', 'comment']);
        const shard = jobBlock(fullSuite, 'shard');
        assert.match(shard, /matrix:\n\s+shard: \[1, 2, 3, 4\]\n/);
        for (const job of ['shard', 'docs']) {
            assert.match(jobBlock(fullSuite, job), /runs-on: \$\{\{ fromJSON\(/, `${job} supports both routes`);
        }
        assert.match(shard, /\n {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| !github\.event\.pull_request\.draft \}\}\n/, 'shards run for ready PRs and dispatches');
        // The docs job keeps the same draft handling and is additionally
        // gated on the shared classifier; test/ciFullSuiteSelection.test.mjs
        // evaluates the full condition.
        assert.match(jobBlock(fullSuite, 'docs'), /\n {10}\(github\.event_name == 'workflow_dispatch' \|\| !github\.event\.pull_request\.draft\) &&\n/);
        for (const job of ['classify', 'native-electron', 'test', 'comment']) assert.match(jobBlock(fullSuite, job), /\n {4}runs-on: ubuntu-latest\n/);
        assert.doesNotMatch(fullSuite, /run-local-shards|LOCAL_SHARD/, 'no nested local shard coordinator');
        assert.ok(!existsSync(join(REPOSITORY, 'scripts', 'run-local-shards.mjs')));
        assert.doesNotMatch(fullSuite, /pull_request_target/);
        assert.doesNotMatch(fullSuite, /secrets\./);
    });

    test('isolates every eligible job and cleans up even on failure or cancellation', () => {
        for (const [name, block] of routedJobs()) {
            assert.match(block, /persist-credentials: false/, name);
            assert.doesNotMatch(block, /clean: false/, `${name} keeps the clean checkout`);
            assert.match(block, /- name: Isolate job state from the shared host\n\s+if: runner\.environment == 'self-hosted'\n/, name);
            const isolate = extractRunBlock(block, 'Isolate job state from the shared host');
            assert.ok(isolate.indexOf('./scripts/ci-rootless-preflight.sh') < isolate.indexOf('echo "HOME='), name);
            assert.match(isolate, /echo "DOCKER_CONFIG=\$job_root\/home\/\.docker"/, name);
            assert.match(isolate, /^job_root="\$RUNNER_TEMP\/ci"$/m, name);
            for (const variable of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH']) {
                assert.match(isolate, new RegExp(`echo "${variable}=\\$job_root/`), `${name} ${variable}`);
            }
            // The runner tree can have a group-writable ancestor that the CLI's
            // private-directory checks reject, so TMPDIR is a private mktemp
            // directory under the sticky /tmp, as on hosted runners.
            assert.match(isolate, /^tmp_dir="\$\(mktemp -d \/tmp\/propr-ci\.XXXXXX\)"$/m, name);
            assert.match(isolate, /echo "TMPDIR=\$tmp_dir"\n\s+echo "PROPR_CI_TMPDIR=\$tmp_dir"\n/, name);
            assert.doesNotMatch(isolate, /\$job_root\/tmp/, name);
            assert.match(block, /- name: Record runner placement\n(?:\s+env:\n\s+PROPR_EVIDENCE_LABEL: [^\n]+\n)?\s+run: \.\/scripts\/ci-runner-evidence\.sh\n/, name);
            assert.doesNotMatch(block, /--with-deps/, `${name} never apt-installs onto the host`);
            const cleanup = block.slice(block.indexOf('- name: Remove job files from the persistent workspace'));
            assert.match(cleanup, /^- name: Remove job files from the persistent workspace\n\s+if: always\(\) && runner\.environment == 'self-hosted'\n\s+run: \|\n\s+git -C "\$GITHUB_WORKSPACE" clean -ffdxq\n\s+case "\$\{PROPR_CI_TMPDIR:-\}" in \/tmp\/propr-ci\.\*\) rm -rf -- "\$PROPR_CI_TMPDIR" ;; esac\n/, name);
            assert.doesNotMatch(cleanup.slice(cleanup.indexOf('\n')), /- name: /, `${name} cleans up after its uploads, as the last step`);
        }
        assert.match(extractRunBlock(jobBlock(fullSuite, 'docs'), 'Isolate job state from the shared host'), /echo "PROPR_CACHE_DIR=\$job_root\/setup"/);
        for (const workflow of [fullSuite, buildCheck, readWorkflow('test-nightly.yml')]) {
            assert.doesNotMatch(workflow, /docker (?:system|container|volume|image) prune|docker rm[^\n]*\$\(docker ps|docker kill/, 'no machine-wide Docker cleanup');
        }
    });

    test('isolates each shard Redis by shard and attempt and records the worker that ran it', () => {
        const shard = jobBlock(fullSuite, 'shard');
        assert.equal(shard.match(/CI_REDIS_INSTANCE: shard-\$\{\{ matrix\.shard \}\}\n\s+run: \.\/scripts\/ci-redis\.sh (?:start|stop)/g).length, 2);
        assert.match(shard, /- name: Stop isolated Redis\n\s+if: always\(\) && \(runner.environment != 'self-hosted' \|\| env.PROPR_ROOTLESS_DOCKER_READY == 'true'\)\n/);
        assert.match(shard, /PROPR_EVIDENCE_LABEL: shard \$\{\{ matrix\.shard \}\}\/4\n/);
        const stages = shard.slice(shard.indexOf('- name: Record shard stage outcomes'), shard.indexOf('- name: Sanitize test output'));
        assert.match(stages, /const runner = \{ name: env\.RUNNER_NAME, environment: env\.RUNNER_ENVIRONMENT \};/);
        assert.match(stages, /\{ shard: Number\(env\.SHARD\), runAttempt: Number\(env\.GITHUB_RUN_ATTEMPT\), runner, stages \}/);
        assert.match(jobBlock(fullSuite, 'comment'), /\$\{shard\.runner\.name\}/, 'the failure comment names each shard\'s worker');
    });

    test('requires real hosted native Electron assertions on both routes', () => {
        const electron = jobBlock(fullSuite, 'native-electron');
        assert.match(electron, /\n {10}\(github\.event_name == 'workflow_dispatch' \|\| !github\.event\.pull_request\.draft\) &&\n/);
        assert.match(electron, /PROPR_REQUIRE_NATIVE_ELECTRON: '1'/);
        const run = extractRunBlock(electron, 'Run native Electron units without skipping');
        const units = spawnSync('bash', ['-c', `${run.split('\n').filter(line => line.startsWith('mapfile')).join('\n')}\nprintf '%s\\n' "\${files[@]}"`], {
            cwd: REPOSITORY,
            encoding: 'utf8',
        }).stdout.trim().split('\n');
        assert.deepEqual(units, [
            'apps/desktop/scripts/electron-frame-semantics.test.mjs',
            'apps/desktop/scripts/electron-pairing-zstd.test.mjs',
        ]);
        assert.match(run, /node scripts\/run-test-suite\.mjs "\$\{files\[@\]\}"/);
        // The workflow-level shard count must not reach this unsharded run.
        assert.match(electron, /PROPR_TEST_SHARD_COUNT: ''\n/);
    });

    test('fails the required gate closed for shards, docs, coverage and native Electron', () => {
        const gate = jobBlock(fullSuite, 'test');
        assert.match(gate, /name: Run Full Test Suite\n/);
        assert.match(gate, /needs: \[classify, shard, docs, native-electron\]/);
        const enforce = extractRunBlock(gate, 'Enforce shard and docs results');
        const runGate = env => spawnSync('bash', ['-e', '-c', enforce], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, COVERAGE_RESULT: 'success', ...env },
        });
        const passed = { SHARD_RESULT: 'success', DOCS_RESULT: 'success', ELECTRON_RESULT: 'success', COVERAGE_RESULT: 'success' };
        assert.equal(runGate(passed).status, 0);
        // Without successful classifier evidence no skip is ever accepted; the
        // accepted surface skips are covered in test/ciFullSuiteSelection.test.mjs.
        for (const [variable, message] of [
            ['SHARD_RESULT', /shards finished with result/],
            ['DOCS_RESULT', /Docs site validation finished with result/],
            ['ELECTRON_RESULT', /native Electron units finished with result/],
            ['COVERAGE_RESULT', /coverage verification finished with result/],
        ]) {
            for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
                const result = runGate({ ...passed, [variable]: outcome });
                assert.equal(result.status, 1, `${variable}=${outcome}`);
                assert.match(result.stdout, message);
            }
        }
    });

    test('reports surface-gated skips with the classifier decision behind them', () => {
        const comment = jobBlock(fullSuite, 'comment');
        assert.match(comment, /needs: \[classify, shard, docs, native-electron, test\]/);
        const skipped = runFailureComment(freshDirectory('report-skips'), comment, {
            DOCS_JOB_RESULT: 'skipped', DOCS_DECISION: 'false', ELECTRON_RESULT: 'skipped', DESKTOP_DECISION: 'false',
        });
        assert.match(skipped, /^- Docs site validation: skipped \(classifier decision: false\)$/m);
        assert.match(skipped, /^- Hosted native Electron units: skipped \(classifier decision: false\)$/m);
        assert.doesNotMatch(skipped, /Dependency install: not run/);
        const unexplained = runFailureComment(freshDirectory('report-unexplained'), comment, {
            DOCS_JOB_RESULT: 'success', INSTALL_RESULT: 'success', BUILD_RESULT: 'success', DOCS_RESULT: 'success', ELECTRON_RESULT: 'skipped',
        });
        assert.match(unexplained, /^- Docs validation: success$/m);
        assert.match(unexplained, /^- Hosted native Electron units: skipped \(classifier decision: none\)$/m);
    });

    test('reports cancelled shards as cancelled and posts no report for a superseded run', () => {
        const gate = jobBlock(fullSuite, 'test');
        assert.match(gate, /\$\{\{ always\(\) &&\n/, 'the gate still fails a cancelled run closed');
        assert.doesNotMatch(gate, /cancelled\(\)/);
        const comment = jobBlock(fullSuite, 'comment');
        assert.match(comment, /\$\{\{ always\(\) && !cancelled\(\) && github\.event_name == 'pull_request' &&\n/);

        const directory = freshDirectory('report');
        const writeShard = (shard, stages, summary) => {
            const output = join(directory, 'shard-artifacts', `shard-${shard}`);
            mkdirSync(output, { recursive: true });
            writeFileSync(join(output, 'stages.json'), JSON.stringify({ shard, runAttempt: 1, runner: { name: `worker-${shard}` }, stages }));
            if (summary) writeFileSync(join(output, 'summary.json'), JSON.stringify(summary));
            writeFileSync(join(output, 'test_output.sanitized.txt'), `shard ${shard} output`);
        };
        const passedStages = { 'Dependency install': 'success', 'Test shard': 'success' };
        writeShard(1, passedStages, { shard: { index: 1 }, durationMs: 1000, results: [] });
        writeShard(2, { 'Dependency install': 'success', 'Test shard': 'cancelled' });
        writeShard(3, { 'Dependency install': 'success', 'Test shard': 'failure' }, {
            shard: { index: 3 }, durationMs: 2000, results: [{ id: 'test/a.test.ts', status: 'failed', reason: 'exit 1' }],
        });
        const body = runFailureComment(directory, comment);
        assert.match(body, /^- Shard 1\/4: passed in 1\.0s on worker-1$/m);
        assert.match(body, /^- Shard 2\/4: cancelled during Test shard on worker-2$/m);
        assert.match(body, /^- Shard 3\/4: failed during Test shard in 2\.0s on worker-3$/m);
        assert.match(body, /^  - `test\/a\.test\.ts`: exit 1$/m);
        assert.match(body, /^- Shard 4\/4: no output uploaded/m);
        assert.match(body, /Validation failed during: Test shard \(shard 2, cancelled\), Test shard \(shard 3\), Shard coverage verification\./);
        assert.match(body, /View shard 2\/4 output[\s\S]*shard 2 output/);
        assert.doesNotMatch(body, /shard 1 output/);
        assert.doesNotMatch(body, /truncated/);
        assert.ok(body.length <= 65536);
    });

    test('bounds the entire failure comment with many rows, huge reasons and expanded log fences', async (t) => {
        const comment = jobBlock(fullSuite, 'comment');
        for (const scenario of ['many failures and logs', 'oversized reason', 'rows without logs', 'oversized summary']) {
            await t.test(scenario, () => {
                const directory = freshDirectory('bounded-report');
                const hasLogs = scenario !== 'rows without logs';
                for (let shard = 1; shard <= 4; shard += 1) {
                    const output = join(directory, 'shard-artifacts', `shard-${shard}`);
                    mkdirSync(output, { recursive: true });
                    const stages = scenario === 'oversized summary'
                        ? { ['stage'.repeat(20000)]: 'failure' }
                        : hasLogs ? { 'Test shard': 'failure' } : {};
                    writeFileSync(join(output, 'stages.json'), JSON.stringify({ shard, stages }));
                    const results = scenario === 'oversized reason'
                        ? [{ id: 'test/huge.test.ts', status: 'failed', reason: 'reason'.repeat(20000) }]
                        : Array.from({ length: 500 }, (_, index) => ({
                            id: `test/shard-${shard}-unit-${index}.test.ts`,
                            status: 'failed',
                            reason: `exit 1: ${'failure detail '.repeat(10)}`,
                        }));
                    writeFileSync(join(output, 'summary.json'), JSON.stringify({ durationMs: 1000, results }));
                    if (hasLogs) writeFileSync(join(output, 'test_output.sanitized.txt'),
                        '~~~ 💥 test output\n'.repeat(10000) + `shard ${shard} log tail`);
                }
                const body = runFailureComment(directory, comment);
                assert.ok(body.length <= 65536, `complete body has ${body.length} UTF-16 units`);
                assert.match(body, /^<!-- propr-full-test-results -->\n### Full Test Suite Results/);
                assert.match(body, /Details truncated; see the uploaded artifacts/);
                assert.ok(body.endsWith('[View uploaded artifacts](https://github.com/o/r/actions/runs/1#artifacts)'));
                assert.match(body, /\*\*\[View Workflow\]\(https:\/\/github.com\/o\/r\/actions\/runs\/1\)\*\*/);
                assert.equal((body.match(/^<details>$/gm) ?? []).length, hasLogs ? 4 : 0);
                assert.equal((body.match(/^<\/details>$/gm) ?? []).length, hasLogs ? 4 : 0);
                assert.equal((body.match(/^~~~(?:text)?$/gm) ?? []).length, hasLogs ? 8 : 0);
                if (hasLogs) {
                    for (let shard = 1; shard <= 4; shard += 1) {
                        assert.ok(body.includes(`View shard ${shard}/4 output`));
                        assert.ok(body.includes(`shard ${shard} log tail`));
                    }
                }
            });
        }
    });

    test('routes compatible build checks while keeping native and ordinary-user checks hosted', () => {
        const validate = jobBlock(buildCheck, 'validate');
        assert.match(validate, /runs-on: \$\{\{ fromJSON\(/);
        // One install, for the Playwright smoke test that nothing else covers.
        assert.equal(validate.split('./scripts/ci-install-chromium.sh').length - 1, 1);
        const toolContainers = validate.match(/docker run [^\n]*\n[^\n]*\n/g);
        assert.equal(toolContainers.length, 2);
        assert.equal(validate.match(/--mount "type=bind,source=\$GITHUB_WORKSPACE,target=\/work,readonly"/g).length, 2);
        assert.doesNotMatch(validate, /--volume/);
        for (const container of toolContainers) {
            assert.match(container, /--rm/);
            assert.match(container, /--network none --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256/, 'tool containers retain individual limits in addition to the per-user cap');
        }
        const expected = {
            'cli-agent-skill-glibc-231': 'ubuntu-latest',
            'cli-agent-skill-darwin': 'macos-15',
            'windows-connect-discovery': 'windows-2025',
            'connect-authority-darwin': 'macos-15',
            comment: 'ubuntu-latest',
            // Selection and its fail-closed aggregate are cheap hosted jobs.
            classify: 'ubuntu-latest',
            'compatibility-guard': 'ubuntu-latest',
        };
        assert.deepEqual(jobNames(buildCheck).sort(), [...Object.keys(expected), 'validate', 'cli-node-matrix'].sort());
        for (const [job, runner] of Object.entries(expected)) {
            assert.match(jobBlock(buildCheck, job), new RegExp(`\n    runs-on: ${runner}\n`), job);
        }
        for (const desktop of ['desktop-release-guard.yml', 'desktop-connect-discovery-guard.yml']) {
            assert.doesNotMatch(readWorkflow(desktop), /self-hosted/, `${desktop} stays hosted`);
        }
    });

    test('consolidates the Linux CLI checks into one install with every constituent reported', () => {
        const cli = jobBlock(buildCheck, 'cli-node-matrix');
        assert.match(cli, /name: CLI Agent Skill \(Node \$\{\{ matrix\.node \}\}\)\n/, 'the check name is unchanged');
        assert.match(cli, /matrix:\n\s+node: \[22, 24\]\n/, 'both Node versions still run');
        assert.equal(cli.match(/run: npm ci\n/g).length, 1, 'one clean install serves every constituent');
        assert.equal(cli.match(/npm run build -w @propr\/shared\n/g).length, 1, 'one dependency build');
        // The former `CLI init JSON (Node N)` job's command, with the same
        // dependency build it used to make for itself.
        assert.match(cli, /- name: Parse init JSON output\n\s+id: init_json\n\s+continue-on-error: true\n\s+run: npx tsx --test packages\/cli\/src\/commands\/initCommands\.test\.ts\n/);
        assert.ok(!jobNames(buildCheck).includes('cli-init-json'));
        // Constituents do not mask each other: a failing Agent Skill suite
        // still lets init JSON and the CLI build report their own results.
        for (const id of ['agent_skill', 'init_json', 'cli_build']) {
            assert.match(cli, new RegExp(`id: ${id}\\n\\s+continue-on-error: true\\n`), id);
        }

        const gate = extractRunBlock(cli, 'Enforce combined CLI validation results');
        assert.match(cli, /- name: Enforce combined CLI validation results\n\s+if: always\(\)\n/);
        const outcomes = ['WORKSPACE_BUILD_RESULT', 'AGENT_SKILL_RESULT', 'INIT_JSON_RESULT', 'CLI_BUILD_RESULT'];
        const labels = [
            'Workspace dependency build',
            'CLI Agent Skill typecheck and tests',
            'CLI init JSON output',
            'CLI build and packaged asset assertions',
        ];
        const evaluate = environment => spawnSync('bash', ['-c', gate], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, ...environment },
        });
        const allSucceeded = Object.fromEntries(outcomes.map(name => [name, 'success']));

        const passing = evaluate(allSucceeded);
        assert.equal(passing.status, 0, passing.stderr);
        for (const label of labels) assert.ok(passing.stdout.includes(`${label}: success`), label);

        // Missing, failed, cancelled and skipped validation all fail closed.
        for (const name of outcomes) {
            for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
                const result = evaluate({ ...allSucceeded, [name]: outcome });
                assert.equal(result.status, 1, `${name}=${JSON.stringify(outcome)}`);
                assert.match(result.stdout, /::error::/);
            }
        }
        const reported = evaluate({ ...allSucceeded, AGENT_SKILL_RESULT: 'failure' }).stdout;
        for (const label of labels) assert.ok(reported.includes(label), `${label} is still reported`);
    });

    test('keeps sanitized artifacts and selects earlier successful shard attempts on partial reruns', () => {
        const shard = jobBlock(fullSuite, 'shard');
        assert.match(shard, /sanitize-ci-output\.mjs test_output\.txt shard-output\/test_output\.sanitized\.txt/);
        assert.match(shard, /name: full-test-output-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-shard-/);
        for (const job of ['test', 'comment']) assert.match(jobBlock(fullSuite, job), /pattern: full-test-output-\$\{\{ github.run_id \}\}-\*-shard-\*/);
        const validate = jobBlock(buildCheck, 'validate');
        assert.match(validate, /sanitize-ci-output\.mjs build_log\.txt build_log\.sanitized\.txt/);
        assert.match(validate, /path: build_log\.sanitized\.txt/);
        assert.doesNotMatch(validate, /path: build_log\.txt/);
        assert.match(jobBlock(buildCheck, 'comment'), /readFileSync\('build_log\.sanitized\.txt'/);
    });

    test('installs Chromium system packages only on disposable hosted runners', () => {
        const root = freshDirectory('chromium-helper');
        writeFileSync(join(root, 'npx'), '#!/usr/bin/env bash\necho "npx $*"\n');
        chmodSync(join(root, 'npx'), 0o755);
        const install = environment => spawnSync('bash', [join(REPOSITORY, 'scripts', 'ci-install-chromium.sh')], {
            encoding: 'utf8',
            env: { PATH: `${root}:${process.env.PATH}`, ...(environment ? { RUNNER_ENVIRONMENT: environment } : {}) },
        }).stdout.trim();
        assert.equal(install('github-hosted'), 'npx playwright install --with-deps chromium');
        assert.equal(install('self-hosted'), 'npx playwright install chromium');
        assert.equal(install(undefined), 'npx playwright install chromium');
        for (const [name, block] of routedJobs()) {
            assert.doesNotMatch(block, /--with-deps/, name);
        }
    });
});

describe('rootless runner prerequisites', () => {
    function preflight(overrides = {}) {
        const root = freshDirectory('rootless');
        const bin = join(root, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
set -eu
[[ "$DOCKER_HOST" == unix:///run/user/1001/docker.sock ]]
[[ "$DOCKER_CONFIG" == "$RUNNER_TEMP/propr-docker-client" ]]
[[ "$(cat "$DOCKER_CONFIG/config.json")" == '{"auths":{}}' ]]
case "$*" in
  *SecurityOptions*) echo "\${FAKE_SECURITY-name=rootless}" ;;
  *CgroupVersion*) echo "\${FAKE_CGROUPS-2/systemd}" ;;
  *) exit 90 ;;
esac
`);
        chmodSync(join(bin, 'docker'), 0o755);
        // Image executables are prerequisites, not dependencies of this test host.
        for (const executable of ['git', 'curl', 'tar', 'gzip', 'unzip', 'python3', 'make', 'g++', 'sha256sum', 'timeout', 'node', 'npm']) {
            writeFileSync(join(bin, executable), '#!/usr/bin/env bash\nexit 0\n');
            chmodSync(join(bin, executable), 0o755);
        }
        const envFile = join(root, 'env');
        writeFileSync(envFile, '');
        const result = spawnSync('bash', [join(REPOSITORY, 'scripts/ci-rootless-preflight.sh')], {
            encoding: 'utf8',
            env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, RUNNER_TEMP: root,
                GITHUB_WORKSPACE: root, GITHUB_ENV: envFile,
                DOCKER_HOST: 'unix:///run/user/1001/docker.sock', ...overrides },
        });
        return { ...result, exported: readFileSync(envFile, 'utf8') };
    }

    test('pins only the explicit rootless daemon across HOME changes without inherited client credentials', () => {
        const result = preflight({ DOCKER_CONFIG: '/unrelated/client/config' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.exported, /^DOCKER_HOST=unix:\/\/\/run\/user\/1001\/docker.sock$/m);
        assert.match(result.exported, /^DOCKER_CONTEXT=$/m);
        assert.match(result.exported, /^PROPR_ROOTLESS_DOCKER_READY=true$/m);
        assert.match(result.stdout, /still require pilot evidence/);
    });

    test('fails before enabling cleanup for missing, conflicting, rootful or unbounded Docker endpoints', () => {
        for (const overrides of [
            { DOCKER_HOST: '' }, { DOCKER_HOST: 'unix:///var/run/docker.sock' },
            { DOCKER_HOST: 'unix:///run/docker.sock' }, { DOCKER_HOST: 'tcp://localhost:2375' },
            { DOCKER_CONTEXT: 'production' }, { DOCKER_TLS_VERIFY: '1' },
            { FAKE_SECURITY: 'name=seccomp' }, { FAKE_CGROUPS: '2/none' },
            { FAKE_CGROUPS: '1/systemd' }, { GITHUB_WORKSPACE: '/nonexistent-propr-workspace' },
        ]) {
            const result = preflight(overrides);
            assert.notEqual(result.status, 0, JSON.stringify(overrides));
            assert.match(result.stderr, /Rootless runner prerequisite:/);
            assert.doesNotMatch(result.stderr, /missing .* in the runner image/);
            assert.equal(result.exported, '', JSON.stringify(overrides));
        }
    });
});
