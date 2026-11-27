/**
 * OpenCode 2.x calls MCP tools (and its other Code Mode tools) through one
 * `execute` tool whose input is JavaScript such as
 * `return await tools.gw.lookup({q: "x"})`. The completed part lists the calls
 * the script made in `state.metadata.metadata.toolCalls`:
 *
 * ```json
 * {"type":"tool","id":"call_3","tool":"execute","state":{"status":"completed",
 *   "input":{"code":"return await tools.gw.lookup({q:\"x\"})"},"output":"…",
 *   "metadata":{"metadata":{"toolCalls":[{"tool":"gw.lookup","status":"completed","input":{"q":"x"}}]}}}}
 * ```
 *
 * For logs and the live view such a step reads better under the tools it
 * called: one call shows as `gw.lookup` with its own input; several show
 * joined (`gw.lookup, local_stub.echo_secret`) with the calls and the script as
 * input. The result stays the `execute` output. Scripts without tool calls keep
 * the plain `execute` name and code input.
 */

export interface OpenCodeCodeModeToolCall {
    tool: string;
    status?: string;
    input?: unknown;
}

export const OPENCODE_CODE_MODE_TOOL = 'execute';

interface OpenCodeCodeModeSource {
    tool?: string;
    tool_name?: string;
    name?: string;
    state?: { input?: unknown; metadata?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The Code Mode tool calls an `execute` part made, or an empty list for any other part. */
export function openCodeCodeModeToolCalls(source: OpenCodeCodeModeSource | undefined): OpenCodeCodeModeToolCall[] {
    if (!source || (source.tool_name || source.tool || source.name) !== OPENCODE_CODE_MODE_TOOL) return [];
    const metadata = source.state?.metadata;
    const nested = isRecord(metadata) && isRecord(metadata.metadata) ? metadata.metadata : undefined;
    const calls = nested?.toolCalls;
    if (!Array.isArray(calls)) return [];
    return calls.flatMap(call => (isRecord(call) && typeof call.tool === 'string' && call.tool
        ? [{ tool: call.tool, ...(typeof call.status === 'string' ? { status: call.status } : {}), ...('input' in call ? { input: call.input } : {}) }]
        : []));
}

/**
 * The readable tool name and input of an `execute` part that called Code Mode
 * tools, or undefined when the part should be shown as it is.
 */
export function openCodeCodeModeToolDisplay(source: OpenCodeCodeModeSource | undefined): { toolName: string; input: Record<string, unknown> } | undefined {
    const calls = openCodeCodeModeToolCalls(source);
    if (!calls.length) return undefined;
    if (calls.length === 1) {
        const input = calls[0].input;
        return { toolName: calls[0].tool, input: isRecord(input) ? input : input === undefined ? {} : { value: input } };
    }
    const code = isRecord(source?.state?.input) ? source.state.input.code : undefined;
    return {
        toolName: [...new Set(calls.map(call => call.tool))].join(', '),
        input: { calls, ...(typeof code === 'string' ? { code } : {}) },
    };
}
