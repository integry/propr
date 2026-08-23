import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    buildAgentContainerResourceArgs,
    resolveDefaultAgentCpuLimit,
} from '../packages/core/src/agents/agentContainerResources.js';

describe('agent container resource policy', () => {
    test('caps the automatic CPU default at detected host capacity', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({}, 2), [
            '--memory', '6g',
            '--memory-swap', '6g',
            '--cpus', '2',
            '--pids-limit', '512',
        ]);
        assert.equal(resolveDefaultAgentCpuLimit(16), '4');
        assert.equal(resolveDefaultAgentCpuLimit(1), '1');
    });

    test('uses a conservative CPU fallback when detection is invalid', () => {
        assert.equal(resolveDefaultAgentCpuLimit(0), '1');
        assert.equal(resolveDefaultAgentCpuLimit(Number.NaN), '1');
    });

    test('accepts explicit operator overrides', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({
            AGENT_CONTAINER_MEMORY_LIMIT: ' 12G ',
            AGENT_CONTAINER_CPU_LIMIT: '1.5',
            AGENT_CONTAINER_PIDS_LIMIT: '1024',
        }), [
            '--memory', '12g',
            '--memory-swap', '12g',
            '--cpus', '1.5',
            '--pids-limit', '1024',
        ]);
    });

    test('enforces Docker\'s minimum memory limit', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({ AGENT_CONTAINER_MEMORY_LIMIT: '6m' }, 4), [
            '--memory', '6m',
            '--memory-swap', '6m',
            '--cpus', '4',
            '--pids-limit', '512',
        ]);
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_MEMORY_LIMIT: '5m' }),
            /AGENT_CONTAINER_MEMORY_LIMIT/
        );
    });

    test('enforces Docker\'s minimum effective CPU quota', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({ AGENT_CONTAINER_CPU_LIMIT: '0.01' }), [
            '--memory', '6g',
            '--memory-swap', '6g',
            '--cpus', '0.01',
            '--pids-limit', '512',
        ]);
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_CPU_LIMIT: '0.009' }),
            /AGENT_CONTAINER_CPU_LIMIT/
        );
    });

    test('rejects malformed or unbounded values before invoking Docker', () => {
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_MEMORY_LIMIT: '0' }),
            /AGENT_CONTAINER_MEMORY_LIMIT/
        );
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_CPU_LIMIT: 'all' }),
            /AGENT_CONTAINER_CPU_LIMIT/
        );
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_PIDS_LIMIT: '-1' }),
            /AGENT_CONTAINER_PIDS_LIMIT/
        );
    });
});
