import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
    getAgentRuntimeImageTag,
    type AgentRuntimePackageState
} from '../packages/core/src/agents/runtime/agentRuntimePackages.js';
import {
    verifyAgentRuntimePackageProfile,
    type AgentRuntimePackageVerificationOptions
} from '../packages/core/src/agents/runtime/agentRuntimePackageVerification.js';
import type { ExecutionResult } from '../packages/core/src/claude/docker/dockerExecutor.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => closeConnection());

const BASE_IMAGE = 'propr/agent:bundle-test';
const BASE_ID = 'sha256:current-base';
const INSTALLATION_ID = 'installation-test';
const USER = 'node:node';

function dockerResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
    return {
        stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map(), ...overrides
    };
}

function metadata(id: string, user = USER, labels: Record<string, string> = {}): string {
    return `${JSON.stringify(id)}\t${JSON.stringify(user)}\t${JSON.stringify(labels)}\n`;
}

interface FixtureOptions {
    desired?: string[];
    active?: string[];
    currentBaseId?: string;
    recordedBaseId?: string;
    recordedImage?: string;
    baseUser?: string;
    derivedUser?: string;
    labels?: Record<string, string>;
    installed?: Record<string, string | undefined>;
    missingDerived?: boolean;
    baseFailure?: Partial<ExecutionResult>;
    packageFailure?: Partial<ExecutionResult>;
}

function fixture(options: FixtureOptions = {}): {
    state: AgentRuntimePackageState;
    verificationOptions: AgentRuntimePackageVerificationOptions;
    dockerCalls: string[][];
} {
    const desired = options.desired ?? ['jq=1.7'];
    const active = options.active ?? desired;
    const currentBaseId = options.currentBaseId ?? BASE_ID;
    const recordedBaseId = options.recordedBaseId ?? currentBaseId;
    const image = options.recordedImage
        ?? getAgentRuntimeImageTag(BASE_IMAGE, recordedBaseId, active, INSTALLATION_ID);
    const labels = options.labels ?? {
        'dev.propr.agent-runtime': 'true',
        'dev.propr.agent-runtime.installation': INSTALLATION_ID
    };
    const state: AgentRuntimePackageState = {
        installationId: INSTALLATION_ID,
        packages: desired,
        activePackages: active,
        status: active.length ? 'ready' : 'disabled',
        images: active.length ? {
            [BASE_IMAGE]: {
                baseImage: BASE_IMAGE,
                baseImageId: recordedBaseId,
                image,
                packageManager: 'apt',
                builtAt: '2026-08-25T00:00:00.000Z'
            }
        } : {},
        updatedAt: '2026-08-25T00:00:00.000Z'
    };
    const dockerCalls: string[][] = [];
    const executeDocker: NonNullable<AgentRuntimePackageVerificationOptions['executeDocker']> = async (_command, args) => {
        dockerCalls.push(args);
        if (args[0] === 'image' && args[2] === BASE_IMAGE) {
            if (options.baseFailure) return dockerResult(options.baseFailure);
            return dockerResult({ stdout: metadata(currentBaseId, options.baseUser ?? USER) });
        }
        if (args[0] === 'image' && args[2] === image) {
            if (options.missingDerived) return dockerResult({ exitCode: 1, stderr: `No such image: ${image}` });
            return dockerResult({ stdout: metadata('sha256:derived', options.derivedUser ?? USER, labels) });
        }
        if (args[0] === 'run') {
            if (options.packageFailure) return dockerResult(options.packageFailure);
            const installed = options.installed ?? Object.fromEntries(desired.map(spec => {
                const [name, version] = spec.split('=', 2);
                return [name, version || '1.0'];
            }));
            return dockerResult({
                stdout: Object.entries(installed).map(([name, version]) => `${name}|${version || ''}`).join('\n') + '\n'
            });
        }
        throw new Error(`Unexpected Docker arguments: ${args.join(' ')}`);
    };
    return {
        state,
        dockerCalls,
        verificationOptions: {
            executeDocker,
            validateAvailability: async packages => ({
                valid: true,
                packages: packages as string[],
                errors: [],
                availability: [],
                sources: []
            })
        }
    };
}

describe('agent runtime package verification', () => {
    test('accepts a healthy current image and uses a network-disabled package check', async () => {
        const setup = fixture();
        const result = await verifyAgentRuntimePackageProfile(setup.state, [BASE_IMAGE], setup.verificationOptions);

        assert.equal(result.status, 'healthy');
        assert.equal(result.healthy, true);
        assert.equal(result.images[0].packages[0].healthy, true);
        const run = setup.dockerCalls.find(args => args[0] === 'run');
        assert.ok(run);
        assert.deepEqual(run.slice(0, 4), ['run', '--rm', '--network', 'none']);
        assert.equal(run.includes('apt-get'), false);
    });

    test('reports a missing derived image', async () => {
        const setup = fixture({ missingDerived: true });
        const result = await verifyAgentRuntimePackageProfile(setup.state, [BASE_IMAGE], setup.verificationOptions);
        assert.equal(result.healthy, false);
        assert.ok(result.images[0].issues.some(value => value.code === 'derived_image_missing'));
    });

    test('reports stale lineage after a base image is replaced', async () => {
        const setup = fixture({ currentBaseId: 'sha256:replacement', recordedBaseId: 'sha256:original' });
        const result = await verifyAgentRuntimePackageProfile(setup.state, [BASE_IMAGE], setup.verificationOptions);
        assert.ok(result.images[0].issues.some(value => value.code === 'stale_base_image_lineage'));
        assert.equal(result.images[0].resolvedImage, BASE_IMAGE);
    });

    test('reports missing and pinned-version-mismatched packages', async () => {
        const setup = fixture({
            desired: ['curl', 'jq=1.7'],
            installed: { curl: undefined, jq: '1.6' }
        });
        const result = await verifyAgentRuntimePackageProfile(setup.state, [BASE_IMAGE], setup.verificationOptions);
        assert.ok(result.images[0].issues.some(value => value.code === 'package_missing' && value.package === 'curl'));
        assert.ok(result.images[0].issues.some(value => value.code === 'package_version_mismatch' && value.package === 'jq=1.7'));
    });

    test('reports runtime label, installation label, and final-user mismatches', async () => {
        const setup = fixture({ labels: {}, derivedUser: 'root' });
        const result = await verifyAgentRuntimePackageProfile(setup.state, [BASE_IMAGE], setup.verificationOptions);
        const codes = result.images[0].issues.map(value => value.code);
        assert.ok(codes.includes('runtime_label_mismatch'));
        assert.ok(codes.includes('installation_label_mismatch'));
        assert.ok(codes.includes('final_user_mismatch'));
        assert.ok(codes.includes('non_root_user_required'));
    });

    test('reports desired-active drift and recommends apply', async () => {
        const setup = fixture({ desired: ['curl'], active: ['jq'], installed: { curl: '8.0' } });
        const result = await verifyAgentRuntimePackageProfile(setup.state, [BASE_IMAGE], setup.verificationOptions);
        assert.equal(result.desiredActiveDrift, true);
        assert.ok(result.issues.some(value => value.code === 'desired_active_drift'));
        assert.match(result.remediation || '', /runtime packages apply/);
    });

    test('returns an explicit successful disabled result without Docker access', async () => {
        const setup = fixture({ desired: [], active: [] });
        const result = await verifyAgentRuntimePackageProfile(setup.state, [BASE_IMAGE], {
            executeDocker: async () => { throw new Error('Docker must not be called'); },
            validateAvailability: async () => { throw new Error('catalog must not be called'); }
        });
        assert.deepEqual({ status: result.status, healthy: result.healthy, disabled: result.disabled, images: result.images }, {
            status: 'disabled', healthy: true, disabled: true, images: []
        });
    });

    test('turns Docker failures and timeouts into unhealthy structured results', async () => {
        const failure = fixture({ baseFailure: { exitCode: 1, stderr: 'Cannot connect to the Docker daemon' } });
        const failed = await verifyAgentRuntimePackageProfile(failure.state, [BASE_IMAGE], failure.verificationOptions);
        assert.ok(failed.images[0].issues.some(value => value.code === 'base_image_inspection_failed'));

        const timeout = fixture({ packageFailure: { exitCode: null, timedOut: true, timeoutMs: 10 } });
        const timedOut = await verifyAgentRuntimePackageProfile(timeout.state, [BASE_IMAGE], timeout.verificationOptions);
        assert.ok(timedOut.images[0].issues.some(value => value.code === 'package_check_timeout'));
    });

    test('verifies every enabled base image', async () => {
        const first = fixture();
        const secondBase = 'propr/agent:second';
        const secondImage = getAgentRuntimeImageTag(secondBase, BASE_ID, first.state.activePackages, INSTALLATION_ID);
        first.state.images[secondBase] = { ...first.state.images[BASE_IMAGE], baseImage: secondBase, image: secondImage };
        const originalExecutor = first.verificationOptions.executeDocker!;
        first.verificationOptions.executeDocker = async (command, args, options) => {
            const mapped = args.map(value => value === secondBase ? BASE_IMAGE : value === secondImage ? first.state.images[BASE_IMAGE].image : value);
            return originalExecutor(command, mapped, options);
        };
        const result = await verifyAgentRuntimePackageProfile(first.state, [BASE_IMAGE, secondBase], first.verificationOptions);
        assert.equal(result.images.length, 2);
        assert.equal(result.images.every(value => value.healthy), true);
    });
});
