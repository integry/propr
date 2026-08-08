import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildAgentContainerResourceArgs } from '../packages/core/src/agents/agentContainerResources.js';

describe('agent container resource policy', () => {
    test('applies bounded defaults for memory, CPU, and processes', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({}), [
            '--memory', '6g',
            '--memory-swap', '6g',
            '--cpus', '4',
            '--pids-limit', '512',
        ]);
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
