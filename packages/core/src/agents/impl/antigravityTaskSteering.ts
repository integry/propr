import type { Writable } from 'node:stream';
import logger from '../../utils/logger.js';
import {
    DEFAULT_POLL_INTERVAL_MS,
    type LiveInputChannel,
    type LiveInputContext,
    type LiveInputMessage,
    type LiveInputSession,
    type LiveInputSource,
} from '../../claude/docker/dockerLiveInput.js';
import { isAntigravityStreamEvent, parseAntigravityJsonl, type AntigravityParsedOutput } from './utils/antigravityOutputParser.js';
import { splitAntigravityInvocations } from './utils/antigravityInvocations.js';

/**
 * Ordinary Antigravity task runs take operator input at the next step
 * boundary, the mechanism Antigravity goals use: `agy --print` reads one
 * prompt per invocation, so the run is interrupted (Ctrl+C) once a step
 * finished and the same conversation is resumed with the operator's message.
 *
 * All invocations of a run share one container (and its disposable
 * Antigravity state, which keeps the conversation). The container's control
 * script reads one command per stdin line, each payload base64-encoded:
 * the first line is the task prompt; `<conversation id> <message>` interrupts
 * the running invocation and resumes the conversation with the message; end
 * of input waits for the running invocation and exits with its status. The
 * script reports every invocation's end on stdout, so the worker always
 * decides when the run ends.
 */

/** Stdout record the control script writes when an invocation ended; never part of the run output. */
export const ANTIGRAVITY_INVOCATION_EXIT_EVENT = 'propr_invocation_exit';

/** How long a pending steer waits for the running step to finish before interrupting it, as for goals. */
const STEP_BOUNDARY_GRACE_MS = 30_000;

/**
 * Control script of a steerable task container. `"$@"` carries the CLI
 * flags; `agy` runs as a job so it receives Ctrl+C (asynchronous commands of
 * a shell without job control ignore SIGINT), and the shell's own job
 * notices are kept off the run's stderr.
 */
export function buildAntigravitySteerableShellCommand(): string {
    return [
        'set -m',
        'exec 3>&2 2>/dev/null',
        'run_dir="$(mktemp -d)"',
        'invocation=0',
        'status=0',
        'pid=""',
        'start() {',
        '    invocation=$((invocation + 1))',
        '    agy --dangerously-skip-permissions "$@" < "$run_dir/input" 2>&3 &',
        '    pid=$!',
        '}',
        'finish() {',
        '    wait "$pid"',
        '    status=$?',
        '    pid=""',
        `    printf '{"event":"${ANTIGRAVITY_INVOCATION_EXIT_EVENT}","invocation":%d,"exit_code":%d}\\n' "$invocation" "$status"`,
        '}',
        'flags=("$@")',
        'IFS= read -r line || exit 2',
        'printf \'%s\' "$line" | base64 -d > "$run_dir/input" || exit 2',
        'start "${flags[@]}"',
        'partial=""',
        'while :; do',
        '    if IFS= read -r -t 1 chunk; then',
        '        line="$partial$chunk"',
        '        partial=""',
        '        printf \'%s\' "${line#* }" | base64 -d > "$run_dir/input" || continue',
        '        if [ -n "$pid" ]; then kill -INT "$pid" 2>/dev/null; finish; fi',
        '        start "${flags[@]}" --conversation "${line%% *}" --disable-slash-commands',
        '    else',
        '        read_status=$?',
        '        partial="$partial$chunk"',
        '        [ "$read_status" -gt 128 ] || break',
        '        if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then finish; fi',
        '    fi',
        'done',
        '[ -z "$pid" ] || finish',
        'exit "$status"',
    ].join('\n');
}

function encodeCommand(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
}

interface StreamLine {
    event?: string;
    conversation_id?: string;
    invocation?: number;
    step_update?: { state?: string };
}

function parseStreamLine(line: string): StreamLine | null {
    if (!line.includes('"event"')) return null;
    try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === 'object' ? value as StreamLine : null;
    } catch {
        return null;
    }
}

export interface AntigravityTaskSteeringOptions {
    prompt: string;
    source: LiveInputSource;
    pollIntervalMs?: number;
    boundaryGraceMs?: number;
}

export class AntigravityTaskSteeringSession implements LiveInputSession {
    constructor(private readonly options: AntigravityTaskSteeringOptions) {}

    start(stdin: Writable | null | undefined, context: LiveInputContext): LiveInputChannel {
        const { source } = this.options;
        const graceMs = this.options.boundaryGraceMs ?? STEP_BOUNDARY_GRACE_MS;
        const settlements = new Set<Promise<void>>();
        let closed = false;
        let conversationId: string | null = null;
        let stepActive = false;
        let stepCompleted = false;
        let invocationEnded = false;
        let invocation = 1;
        // Claimed while the step runs, written at the next boundary.
        let held: LiveInputMessage[] = [];
        let heldSince: number | null = null;
        // Held input being recorded as written, just before its write.
        let writing = false;
        // Written; delivered once the resumed invocation reports its conversation.
        let resuming: { invocation: number; messages: LiveInputMessage[] } | null = null;
        let polling: Promise<void> = Promise.resolve();
        let timer: ReturnType<typeof setInterval> | undefined;
        let lineBuffer = '';

        const writable = (): boolean => !closed && !!stdin?.writable && !stdin.writableEnded;
        const settle = (promise: Promise<void>): void => {
            settlements.add(promise);
            void promise.finally(() => settlements.delete(promise));
        };
        // Released messages reached no agent, so a later run may deliver them.
        const release = (messages: LiveInputMessage[]): void => {
            if (!messages.length) return;
            settle(source.release(messages.map(message => message.id)).catch(error => {
                logger.warn({ taskId: context.taskId, error: (error as Error).message }, 'Failed to release undelivered operator input');
            }));
        };
        const acknowledge = (messages: LiveInputMessage[]): void => {
            for (const message of messages) {
                settle(source.acknowledge(message.id).catch(error => {
                    logger.warn({ taskId: context.taskId, steerId: message.id, error: (error as Error).message }, 'Failed to acknowledge operator input');
                }));
            }
        };
        const close = (): void => {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
            if (closed) return;
            closed = true;
            // Held input was never written: the run ended before a boundary.
            // Input being recorded as written is released once that settled.
            release(held);
            held = [];
            try { stdin?.end(); } catch { /* the process already closed its input */ }
        };

        stdin?.on('error', error => {
            logger.warn({ taskId: context.taskId, error: error.message }, 'Antigravity control input closed with an error');
            close();
        });
        stdin?.write(`${encodeCommand(this.options.prompt)}\n`);

        // Held input is recorded as possibly delivered just before it is
        // written; until then a later run reclaims it if this worker dies.
        const markWritten = (messages: LiveInputMessage[]): Promise<string[]> => source.markWritten
            ? source.markWritten(messages.map(message => message.id))
            : Promise.resolve(messages.map(message => message.id));
        const write = (messages: LiveInputMessage[]): void => {
            invocation += 1;
            resuming = { invocation, messages };
            const text = messages.map(message => message.text).join('\n\n');
            stdin!.write(`${conversationId} ${encodeCommand(text)}\n`, error => {
                if (!error) return;
                logger.warn({ taskId: context.taskId, error: error.message }, 'Failed to write operator input to Antigravity');
                // The control script never read the command, so nothing resumed.
                if (resuming?.messages === messages) resuming = null;
                release(messages);
            });
            for (const message of messages) context.onDelivered?.(message);
        };

        const resumeAtBoundary = (): void => {
            if (!held.length || writing || !conversationId || invocationEnded || resuming || !writable()) return;
            const atBoundary = !stepActive && stepCompleted;
            if (!atBoundary && Date.now() - (heldSince ?? Date.now()) < graceMs) return;
            const messages = held;
            held = [];
            heldSince = null;
            writing = true;
            settle(markWritten(messages).then(ids => {
                writing = false;
                // Messages no longer held were reclaimed by another run: not this run's to write or release.
                const owned = messages.filter(message => ids.includes(message.id));
                if (!owned.length) return;
                if (!conversationId || invocationEnded || resuming || !writable()) {
                    release(owned);
                    return;
                }
                write(owned);
            }, error => {
                writing = false;
                logger.warn({ taskId: context.taskId, error: (error as Error).message }, 'Failed to record operator input as written');
                // Still held: retried at the next boundary, or released once the run ended.
                if (closed || invocationEnded) {
                    release(messages);
                    return;
                }
                held = [...messages, ...held];
                heldSince ??= Date.now();
            }));
        };

        const poll = async (): Promise<void> => {
            // Claim only once the agent runs and its invocation can still be
            // resumed: claiming before the agent ran, or after it ended, would
            // hold input no boundary will deliver.
            if (!writable() || !conversationId || invocationEnded || resuming || writing || held.length) {
                resumeAtBoundary();
                return;
            }
            try {
                const claimed = await (source.hold ? source.hold() : source.claim());
                if (!claimed.length) return;
                if (closed || invocationEnded) {
                    release(claimed);
                    return;
                }
                held = claimed;
                heldSince = Date.now();
            } catch (error) {
                logger.warn({ taskId: context.taskId, error: (error as Error).message }, 'Failed to load operator input for running agent');
                return;
            }
            resumeAtBoundary();
        };
        timer = setInterval(() => {
            // Never overlap claims: each poll waits for the previous one.
            polling = polling.then(poll);
        }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        timer.unref?.();

        const invocationExited = (ended: number): void => {
            if (resuming && ended === resuming.invocation) {
                // It exited without reporting its conversation: the CLI reports
                // it only after accepting the prompt, so the input was not received.
                release(resuming.messages);
                resuming = null;
            }
            if (!resuming && ended === invocation) close();
        };

        // Records are observed in stream order, together with the control
        // script's invocation records, which are not agent output.
        const observe = (line: string): boolean => {
            const record = parseStreamLine(line);
            if (!record) return true;
            if (record.event === ANTIGRAVITY_INVOCATION_EXIT_EVENT) {
                if (typeof record.invocation === 'number') invocationExited(record.invocation);
                return false;
            }
            if (record.event === 'init' && typeof record.conversation_id === 'string') {
                conversationId ??= record.conversation_id;
                stepActive = false;
                stepCompleted = false;
                invocationEnded = false;
                // The CLI reports its conversation only after accepting the prompt.
                if (resuming) {
                    acknowledge(resuming.messages);
                    resuming = null;
                }
            } else if (record.event === 'step_update') {
                const done = record.step_update?.state === 'DONE';
                stepActive = !done;
                stepCompleted ||= done;
                resumeAtBoundary();
            } else if (record.event === 'result') {
                invocationEnded = true;
                // The run ends with this invocation unless a resume was requested.
                if (!resuming) close();
            }
            return true;
        };

        return {
            observeLine: () => undefined,
            // The CLI reports its conversation only after accepting the prompt.
            promptReceived: () => conversationId !== null,
            translateOutput: (chunk, flush) => {
                lineBuffer += chunk;
                const lines = lineBuffer.split('\n');
                lineBuffer = flush ? '' : lines.pop() ?? '';
                return lines.filter(line => line && observe(line)).map(line => `${line}\n`).join('');
            },
            close,
            settled: async () => {
                await polling;
                await Promise.allSettled([...settlements]);
            },
        };
    }
}

/**
 * Parse a task run's output. A steered run resumes its conversation in later
 * invocations: the last one decides the outcome and reports the
 * conversation's cumulative usage; earlier ones ended at a step boundary
 * with an empty ERROR result, which is an interrupt rather than a failure.
 */
export function parseAntigravityTaskOutput(stdout: string): AntigravityParsedOutput {
    const invocations = splitAntigravityInvocations(stdout);
    if (invocations.length < 2) return parseAntigravityJsonl(stdout);
    const parsed = invocations.map(invocation => parseAntigravityJsonl(invocation));
    const last = parsed[parsed.length - 1]!;
    const conversationId = parsed[0]!.conversationId;
    const resumedElsewhere = parsed.find(invocation => invocation.conversationId !== conversationId);
    const interrupt = (event: AntigravityParsedOutput['conversationLog'][number]): boolean =>
        isAntigravityStreamEvent(event) && event.event === 'result' && !event.result.response;
    return {
        ...last,
        conversationLog: parsed.flatMap((invocation, index) => index === parsed.length - 1
            ? invocation.conversationLog
            : invocation.conversationLog.filter(event => !interrupt(event))),
        protocolError: parsed.map(invocation => invocation.protocolError).find(Boolean)
            ?? (resumedElsewhere ? `Antigravity resumed conversation "${resumedElsewhere.conversationId}" instead of "${conversationId}"` : undefined),
    };
}
