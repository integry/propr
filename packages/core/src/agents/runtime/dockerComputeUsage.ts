import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import type { AgentRunComputeUsage } from './computeUsage.js';
import { ComputeUsageAccumulator, parseCgroupReport, parseDockerStatsLine, type ComputeUsageSample } from './computeUsageSampler.js';

/** Interval between samples of a running container; `0` turns sampling off (wall time is still reported). */
export const COMPUTE_USAGE_SAMPLE_MS_ENV = 'PROPR_COMPUTE_USAGE_SAMPLE_MS';
export const DEFAULT_COMPUTE_USAGE_SAMPLE_MS = 15_000;
/** The first sample comes early so short runs still get a measurement. */
const FIRST_SAMPLE_MS = 2_000;
const SAMPLE_TIMEOUT_MS = 10_000;
/** Consecutive cgroup reads that failed on a running container before the sampler uses `docker stats` only. */
const CGROUP_FAILURES_BEFORE_FALLBACK = 2;

/**
 * Reads the container's own cgroup v2 accounting: cumulative CPU (`cpu.stat`),
 * current and peak memory. Labelled so a missing file (no `memory.peak` before
 * Linux 5.19) cannot shift the other figures.
 */
const CGROUP_REPORT_SCRIPT = 'cd /sys/fs/cgroup 2>/dev/null || exit 3; '
    + 'for f in memory.current memory.peak; do [ -r "$f" ] && printf "%s %s\\n" "$f" "$(cat "$f")"; done; '
    + 'cat cpu.stat 2>/dev/null; exit 0';

export function resolveComputeUsageSampleMs(environment: NodeJS.ProcessEnv = process.env): number {
    const raw = environment[COMPUTE_USAGE_SAMPLE_MS_ENV]?.trim();
    if (!raw) return DEFAULT_COMPUTE_USAGE_SAMPLE_MS;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_COMPUTE_USAGE_SAMPLE_MS;
}

const containerGone = (stderr: string): boolean => /No such container|is not running/i.test(stderr);

export interface DockerComputeUsageSamplerOptions {
    sampleMs?: number;
    /** Docker client environment (`DOCKER_HOST`, ...) of the run. */
    dockerEnvironment?: Readonly<Record<string, string>>;
    now?: () => number;
}

/**
 * Samples one agent container from its start until the run settles: the
 * container's cgroup through `docker exec`, else `docker stats`. A `--rm`
 * container is gone by the time the run settles, so the last sample is the
 * final reading and {@link ComputeUsageAccumulator} extends it to the exit.
 * Sampling is best-effort: a failed sample is skipped, never fails the run.
 */
export class DockerComputeUsageSampler {
    private readonly accumulator: ComputeUsageAccumulator;
    private readonly sampleMs: number;
    private readonly now: () => number;
    private timer?: NodeJS.Timeout;
    private stopped = false;
    private cgroupFailures = 0;
    private useStatsOnly = false;

    constructor(private readonly containerName: string, private readonly options: DockerComputeUsageSamplerOptions = {}) {
        this.now = options.now ?? Date.now;
        this.sampleMs = options.sampleMs ?? resolveComputeUsageSampleMs();
        this.accumulator = new ComputeUsageAccumulator(this.now());
        if (this.sampleMs > 0) this.schedule(Math.min(FIRST_SAMPLE_MS, this.sampleMs));
    }

    /** Stops sampling and returns the run's usage up to now. */
    finish(): AgentRunComputeUsage {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        return this.accumulator.finish(this.now(), 'docker');
    }

    private schedule(delayMs: number): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            void this.sampleOnce().catch(() => undefined).finally(() => this.schedule(this.sampleMs));
        }, delayMs);
        this.timer.unref();
    }

    private dockerOptions() {
        return {
            timeout: SAMPLE_TIMEOUT_MS,
            ...(this.options.dockerEnvironment && { extraEnvVars: { ...this.options.dockerEnvironment } }),
        };
    }

    private async sampleOnce(): Promise<void> {
        const sample = (!this.useStatsOnly && await this.readCgroup()) || await this.readDockerStats();
        if (sample && !this.stopped) this.accumulator.record(sample);
    }

    private async readCgroup(): Promise<ComputeUsageSample | null> {
        const result = await executeDockerCommand('docker', ['exec', this.containerName, 'sh', '-c', CGROUP_REPORT_SCRIPT], this.dockerOptions());
        const sample = result.exitCode === 0 ? parseCgroupReport(result.stdout, this.now()) : null;
        if (sample) {
            this.cgroupFailures = 0;
        } else if (!containerGone(result.stderr)) {
            this.cgroupFailures += 1;
            if (this.cgroupFailures >= CGROUP_FAILURES_BEFORE_FALLBACK) this.useStatsOnly = true;
        }
        return sample;
    }

    private async readDockerStats(): Promise<ComputeUsageSample | null> {
        const result = await executeDockerCommand('docker', [
            'stats', '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}', this.containerName,
        ], this.dockerOptions());
        return result.exitCode === 0 ? parseDockerStatsLine(result.stdout, this.now()) : null;
    }
}
