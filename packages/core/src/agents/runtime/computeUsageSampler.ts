import type { AgentRunComputeUsage } from './computeUsage.js';

/** One observation of a running sandbox. Cumulative CPU is exact; a CPU percentage is integrated. */
export interface ComputeUsageSample {
    atMs: number;
    /** Cumulative CPU time of the sandbox so far (cgroup `cpu.stat` `usage_usec`). */
    cpuSeconds?: number;
    /** Instantaneous CPU use in percent of one core (`docker stats`), when no cumulative figure is available. */
    cpuPercent?: number;
    memoryBytes?: number;
    /** Highest memory the kernel recorded so far (cgroup `memory.peak`). */
    memoryPeakBytes?: number;
}

/**
 * Folds periodic samples of a run into its {@link AgentRunComputeUsage}.
 *
 * Memory is averaged over time: each sample stands for the interval since the
 * previous memory observation (or the start), and the last one is extended to
 * the end of the run since nothing is observed after it. Its peak is the highest sample or kernel-recorded peak. CPU is one
 * running total whatever measured it: a cumulative reading replaces the total
 * (it is exact from the start), a percentage adds its interval on top of the
 * latest reading. The total is extended to the end of the run at the latest
 * observed rate since the sandbox cannot be read once it has exited.
 */
export class ComputeUsageAccumulator {
    /** Latest memory observation, the baseline for the next interval and for the unsampled tail. */
    private lastMemory: { atMs: number; bytes: number } | null = null;
    private memoryWeightedSum = 0;
    private memoryWeightMs = 0;
    private peakMemory: number | null = null;
    /** Latest cumulative reading, the baseline for the rate of the next one. */
    private cumulativeCpu: { atMs: number; seconds: number } | null = null;
    /** CPU-seconds used up to `atMs`, from whichever measurement came last. */
    private cpuTotal: { atMs: number; seconds: number } | null = null;
    /** CPU-seconds per second observed most recently, used for the unsampled tail. */
    private cpuRate: number | null = null;

    constructor(private readonly startMs: number) {}

    get sampled(): boolean {
        return this.peakMemory !== null || this.cpuTotal !== null;
    }

    record(sample: ComputeUsageSample): void {
        if (sample.memoryBytes !== undefined) {
            // Measured from the previous memory observation, so CPU-only samples in between leave no gap.
            const previousAtMs = this.lastMemory?.atMs ?? this.startMs;
            const atMs = Math.max(previousAtMs, sample.atMs);
            const intervalMs = atMs - previousAtMs;
            this.memoryWeightedSum += sample.memoryBytes * intervalMs;
            this.memoryWeightMs += intervalMs;
            this.lastMemory = { atMs, bytes: sample.memoryBytes };
            this.peakMemory = Math.max(this.peakMemory ?? 0, sample.memoryBytes);
        }
        if (sample.memoryPeakBytes !== undefined) this.peakMemory = Math.max(this.peakMemory ?? 0, sample.memoryPeakBytes);
        if (sample.cpuSeconds !== undefined) {
            const previous = this.cumulativeCpu;
            if (!previous || sample.cpuSeconds >= previous.seconds) {
                if (previous && sample.atMs > previous.atMs) {
                    this.cpuRate = (sample.cpuSeconds - previous.seconds) / ((sample.atMs - previous.atMs) / 1000);
                } else if (!previous && sample.atMs > this.startMs) {
                    this.cpuRate = sample.cpuSeconds / ((sample.atMs - this.startMs) / 1000);
                }
                this.cumulativeCpu = { atMs: sample.atMs, seconds: sample.cpuSeconds };
                // Exact from the start, so it supersedes percentages integrated since the last reading.
                this.cpuTotal = { atMs: sample.atMs, seconds: sample.cpuSeconds };
            }
        } else if (sample.cpuPercent !== undefined) {
            // The percentage stands for the interval since the last CPU measurement of either kind.
            const rate = sample.cpuPercent / 100;
            const previous = this.cpuTotal ?? { atMs: this.startMs, seconds: 0 };
            const atMs = Math.max(previous.atMs, sample.atMs);
            this.cpuTotal = { atMs, seconds: previous.seconds + rate * ((atMs - previous.atMs) / 1000) };
            this.cpuRate = rate;
        }
    }

    finish(endMs: number, runtime: string): AgentRunComputeUsage {
        const wallTimeMs = Math.max(0, endMs - this.startMs);
        let cpuSeconds: number | null = null;
        if (this.cpuTotal) {
            const tailSeconds = Math.max(0, (endMs - this.cpuTotal.atMs) / 1000);
            cpuSeconds = this.cpuTotal.seconds + (this.cpuRate ?? 0) * tailSeconds;
        }
        // The latest observation stands for the tail up to the exit; accumulated state is left untouched.
        const tailMs = this.lastMemory ? Math.max(0, endMs - this.lastMemory.atMs) : 0;
        const memoryWeightMs = this.memoryWeightMs + tailMs;
        const memoryWeightedSum = this.memoryWeightedSum + (this.lastMemory?.bytes ?? 0) * tailMs;
        const avgMemoryBytes = memoryWeightMs > 0
            ? memoryWeightedSum / memoryWeightMs
            : this.peakMemory;
        return {
            runtime,
            wallTimeMs,
            cpuSeconds: cpuSeconds === null ? null : Math.round(cpuSeconds * 1000) / 1000,
            peakMemoryBytes: this.peakMemory === null ? null : Math.round(this.peakMemory),
            avgMemoryBytes: avgMemoryBytes === null ? null : Math.round(avgMemoryBytes),
            costUsd: null,
            costSource: null,
        };
    }
}

/**
 * Parses the cgroup v2 report the sampler prints inside the sandbox: lines
 * `memory.current <bytes>`, `memory.peak <bytes>` and the `cpu.stat` lines
 * (`usage_usec <microseconds>`). Missing files leave their figure out.
 */
export function parseCgroupReport(output: string, atMs: number): ComputeUsageSample | null {
    const sample: ComputeUsageSample = { atMs };
    for (const line of output.split('\n')) {
        const [key, value] = line.trim().split(/\s+/);
        const number = Number(value);
        if (!key || value === undefined || !Number.isFinite(number) || number < 0) continue;
        if (key === 'memory.current') sample.memoryBytes = number;
        else if (key === 'memory.peak') sample.memoryPeakBytes = number;
        else if (key === 'usage_usec') sample.cpuSeconds = number / 1e6;
    }
    return sample.memoryBytes !== undefined || sample.cpuSeconds !== undefined ? sample : null;
}

const SIZE_UNITS: Record<string, number> = {
    b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/** `512.3MiB` → bytes; null when unparseable. */
export function parseDockerSize(value: string): number | null {
    const match = /^\s*([\d.]+)\s*([a-z]+)?\s*$/i.exec(value);
    if (!match) return null;
    const factor = SIZE_UNITS[(match[2] ?? 'b').toLowerCase()];
    const amount = Number(match[1]);
    return factor === undefined || !Number.isFinite(amount) ? null : amount * factor;
}

/** Parses `docker stats --format '{{.CPUPerc}}\t{{.MemUsage}}'` output (`12.34%\t512.3MiB / 2GiB`). */
export function parseDockerStatsLine(output: string, atMs: number): ComputeUsageSample | null {
    const [cpu, memory] = output.trim().split('\t');
    if (cpu === undefined || memory === undefined) return null;
    const cpuPercent = Number(cpu.replace('%', '').trim());
    const memoryBytes = parseDockerSize(memory.split('/')[0] ?? '');
    const sample: ComputeUsageSample = { atMs };
    if (Number.isFinite(cpuPercent) && cpuPercent >= 0) sample.cpuPercent = cpuPercent;
    if (memoryBytes !== null) sample.memoryBytes = memoryBytes;
    return sample.cpuPercent !== undefined || sample.memoryBytes !== undefined ? sample : null;
}
