/** Token totals priced the same way recorded executions are (see llmMetrics). */
export interface RunTokenTotals {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}

const ZERO: RunTokenTotals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Claude reports cache reads and writes beside `input_tokens`; Codex reports
 * `cached_input_tokens` as part of `input_tokens`.
 */
function normalizeUsage(usage: Record<string, unknown>): RunTokenTotals {
    const cachedInput = count(usage.cached_input_tokens);
    const input = count(usage.input_tokens ?? usage.prompt_tokens);
    return {
        inputTokens: cachedInput > 0 ? Math.max(0, input - cachedInput) : input,
        outputTokens: count(usage.output_tokens ?? usage.completion_tokens),
        cacheCreationTokens: count(usage.cache_creation_input_tokens),
        cacheReadTokens: cachedInput + count(usage.cache_read_input_tokens),
    };
}

function add(a: RunTokenTotals, b: RunTokenTotals): RunTokenTotals {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    };
}

function max(a: RunTokenTotals, b: RunTokenTotals): RunTokenTotals {
    return {
        inputTokens: Math.max(a.inputTokens, b.inputTokens),
        outputTokens: Math.max(a.outputTokens, b.outputTokens),
        cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
        cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    };
}

/**
 * Accumulates what one agent execution has consumed so far from its streamed
 * JSON lines, so a run can be stopped while it is still executing rather than
 * after its execution row is recorded.
 */
export class RunUsageTally {
    model?: string;
    /** The largest cost the provider itself reported (e.g. Claude's `total_cost_usd`). */
    reportedCostUsd = 0;
    private readonly messages = new Map<string, RunTokenTotals>();
    private unidentified: RunTokenTotals = ZERO;

    constructor(model?: string) {
        this.model = model;
    }

    observeLine(line: string): void {
        // Most lines (tool output, text deltas) carry neither; skip their parse.
        if (!line.includes('usage') && !line.includes('cost')) return;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { return; }
        const event = record(parsed);
        if (!event) return;
        const message = record(event.message);
        const model = message?.model ?? event.model;
        if (typeof model === 'string' && model && !this.model) this.model = model;
        const reported = count(event.total_cost_usd) || count(event.cost_usd);
        if (reported > this.reportedCostUsd) this.reportedCostUsd = reported;
        // Claude's final `result` line repeats the session totals already counted per message.
        if (event.type === 'result') return;
        const usage = record(message?.usage) ?? record(event.usage);
        if (!usage) return;
        const totals = normalizeUsage(usage);
        const id = typeof message?.id === 'string' ? message.id : undefined;
        if (id) {
            // Streamed messages repeat their usage per content block; keep the largest.
            const previous = this.messages.get(id);
            this.messages.set(id, previous ? max(previous, totals) : totals);
        } else {
            this.unidentified = add(this.unidentified, totals);
        }
    }

    get totals(): RunTokenTotals {
        let totals = this.unidentified;
        for (const message of this.messages.values()) totals = add(totals, message);
        return totals;
    }
}
