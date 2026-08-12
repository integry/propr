import { availableParallelism } from 'node:os';

const DEFAULT_MEMORY_LIMIT = '6g';
const DEFAULT_CPU_LIMIT_CEILING = 4;
const DEFAULT_CPU_LIMIT_FALLBACK = 1;
const DEFAULT_PIDS_LIMIT = '512';
const MIN_MEMORY_LIMIT_BYTES = 6n * 1024n * 1024n;
const MIN_CPU_LIMIT = 0.01;

const DOCKER_MEMORY_LIMIT_PATTERN = /^([1-9]\d*)([bkmg])?$/i;
const DOCKER_CPU_LIMIT_PATTERN = /^(?:0?\.\d+|[1-9]\d*(?:\.\d+)?)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

export interface AgentContainerResourceEnvironment {
    AGENT_CONTAINER_MEMORY_LIMIT?: string;
    AGENT_CONTAINER_CPU_LIMIT?: string;
    AGENT_CONTAINER_PIDS_LIMIT?: string;
}

function configuredValue(value: string | undefined, fallback: string): string {
    return value?.trim() || fallback;
}

function validateMemoryLimit(value: string): string {
    const match = DOCKER_MEMORY_LIMIT_PATTERN.exec(value);
    let memoryBytes: bigint | undefined;

    if (match) {
        const amount = BigInt(match[1]);
        switch (match[2]?.toLowerCase()) {
            case 'g':
                memoryBytes = amount * 1024n * 1024n * 1024n;
                break;
            case 'm':
                memoryBytes = amount * 1024n * 1024n;
                break;
            case 'k':
                memoryBytes = amount * 1024n;
                break;
            case 'b':
            case undefined:
                memoryBytes = amount;
                break;
        }
    }

    if (memoryBytes === undefined || memoryBytes < MIN_MEMORY_LIMIT_BYTES) {
        throw new Error(`AGENT_CONTAINER_MEMORY_LIMIT must be a Docker memory value of at least 6m, got: ${value}`);
    }
    return value.toLowerCase();
}

function validateCpuLimit(value: string): string {
    if (!DOCKER_CPU_LIMIT_PATTERN.test(value) || !Number.isFinite(Number(value)) || Number(value) < MIN_CPU_LIMIT) {
        throw new Error(`AGENT_CONTAINER_CPU_LIMIT must be at least ${MIN_CPU_LIMIT} CPUs, got: ${value}`);
    }
    return value;
}

/**
 * Keep the default agent quota within the CPUs actually available to the worker.
 *
 * The normal deployment runs the worker against the same host Docker daemon, so
 * Node's cgroup-aware availableParallelism() reflects the capacity Docker will
 * accept. An explicit AGENT_CONTAINER_CPU_LIMIT remains authoritative. The
 * conservative one-CPU fallback prevents a failed probe from recreating the
 * original failure mode (asking a small Docker host for four CPUs).
 */
export function resolveDefaultAgentCpuLimit(detectedCapacity: number = availableParallelism()): string {
    if (!Number.isSafeInteger(detectedCapacity) || detectedCapacity < 1) {
        return String(DEFAULT_CPU_LIMIT_FALLBACK);
    }
    return String(Math.min(DEFAULT_CPU_LIMIT_CEILING, detectedCapacity));
}

function validatePidsLimit(value: string): string {
    if (!POSITIVE_INTEGER_PATTERN.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`AGENT_CONTAINER_PIDS_LIMIT must be a positive integer, got: ${value}`);
    }
    return value;
}

/**
 * Return the common Docker resource boundary for every coding-agent run.
 *
 * Memory and memory+swap use the same ceiling so an agent cannot move its
 * allocation into host swap after reaching the memory limit. Operators can
 * tune the limits for unusually large repositories, but malformed values fail
 * before Docker starts instead of silently leaving a container unbounded.
 */
export function buildAgentContainerResourceArgs(
    environment: AgentContainerResourceEnvironment = process.env,
    detectedCpuCapacity?: number,
): string[] {
    const memory = validateMemoryLimit(configuredValue(environment.AGENT_CONTAINER_MEMORY_LIMIT, DEFAULT_MEMORY_LIMIT));
    const cpus = validateCpuLimit(configuredValue(
        environment.AGENT_CONTAINER_CPU_LIMIT,
        resolveDefaultAgentCpuLimit(detectedCpuCapacity),
    ));
    const pids = validatePidsLimit(configuredValue(environment.AGENT_CONTAINER_PIDS_LIMIT, DEFAULT_PIDS_LIMIT));

    return [
        '--memory', memory,
        '--memory-swap', memory,
        '--cpus', cpus,
        '--pids-limit', pids,
    ];
}
