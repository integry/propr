import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import fs from 'fs';
import { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { withNotificationDeadline } from '../../services/notificationSchedulerTiming.js';

const TASK_LIVENESS_HEARTBEAT_MS = 30_000;
const MAX_JSON_LINE_BUFFER_CHARS = 1024 * 1024;
const REDIS_STREAMING_CLEANUP_TIMEOUT_MS = 5_000;
const ANSI_REGEX = new RegExp(
    '[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b)
    + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
    'g'
);

export interface RedisStreamingState {
    client: Redis | null;
    interval: ReturnType<typeof setInterval> | null;
    lastLen: number;
    pendingWrite: Promise<void> | null;
}

interface ContainerDetectionState {
    containerIdDetected: boolean;
    containerId: { value: string | null };
}

interface JsonLineMessage {
    type?: string;
    message?: { id?: string };
    session_id?: string;
    conversation_id?: string;
}

interface MessageCaptureContext {
    state: {
        sessionIdDetected: boolean;
        jsonLineBuffer?: string;
        jsonLineTimestamp?: string;
        discardJsonLineUntilNewline?: boolean;
    };
    messageTimestamps: Map<string, string>;
    onSessionId?: (sessionId: string, conversationId?: string) => void;
}

interface CommandSpawnOptions {
    cwd?: string;
    stdinData?: string;
}

async function getTaskEventPublisher() {
    const { getEventPublisher } = await import('../../utils/eventPublisher.js');
    return getEventPublisher();
}

function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_REGEX, '');
}

function resolveDockerPath(command: string): string {
    if (command !== 'docker') return command;
    const paths = ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'];
    for (const path of paths) {
        try {
            if (fs.existsSync(path)) {
                fs.accessSync(path, fs.constants.X_OK);
                logger.debug({ dockerPath: path }, 'Found docker executable');
                return path;
            }
        } catch { /* Continue to the next known Docker path. */ }
    }
    logger.debug('Using docker from PATH');
    return 'docker';
}

export function spawnExecutionCommand(
    command: string,
    args: string[],
    options: CommandSpawnOptions
): ChildProcess {
    const spawnOptions: SpawnOptions = {
        stdio: [options.stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: process.env
    };
    if (options.cwd && fs.existsSync(options.cwd)) {
        spawnOptions.cwd = options.cwd;
    } else if (options.cwd) {
        logger.warn(
            { cwd: options.cwd },
            'Working directory does not exist, spawning from current directory'
        );
    }

    const child = spawn(resolveDockerPath(command), args, spawnOptions);
    if (options.stdinData && child.stdin) {
        child.stdin.on('error', (err) => {
            logger.warn(
                { error: err.message, code: (err as NodeJS.ErrnoException).code },
                'Stdin write error'
            );
        });
        child.stdin.write(options.stdinData);
        child.stdin.end();
        logger.debug(
            { stdinDataLength: options.stdinData.length },
            'Wrote prompt data to stdin'
        );
    }
    return child;
}

export function captureJsonLineMessages(
    chunk: string,
    timestamp: string,
    context: MessageCaptureContext
): void {
    let nextChunk = chunk;
    if (context.state.discardJsonLineUntilNewline) {
        const boundary = nextChunk.indexOf('\n');
        if (boundary < 0) return;
        nextChunk = nextChunk.slice(boundary + 1);
        context.state.discardJsonLineUntilNewline = false;
    }
    const lines = `${context.state.jsonLineBuffer ?? ''}${nextChunk}`.split('\n');
    const trailing = lines.pop() ?? '';
    if (trailing.length > MAX_JSON_LINE_BUFFER_CHARS) {
        context.state.jsonLineBuffer = '';
        context.state.jsonLineTimestamp = undefined;
        context.state.discardJsonLineUntilNewline = true;
    } else {
        context.state.jsonLineBuffer = trailing;
        context.state.jsonLineTimestamp = trailing ? timestamp : undefined;
    }
    for (const line of lines) {
        if (line.length <= MAX_JSON_LINE_BUFFER_CHARS) captureJsonLine(line, timestamp, context);
    }
}

/** Processes a valid trailing JSONL record even when the child omits the final newline. */
export function flushJsonLineMessages(
    fallbackTimestamp: string,
    context: MessageCaptureContext
): void {
    const line = context.state.jsonLineBuffer ?? '';
    const timestamp = context.state.jsonLineTimestamp ?? fallbackTimestamp;
    context.state.jsonLineBuffer = '';
    context.state.jsonLineTimestamp = undefined;
    if (!context.state.discardJsonLineUntilNewline) captureJsonLine(line, timestamp, context);
    context.state.discardJsonLineUntilNewline = false;
}

function captureJsonLine(
    line: string,
    timestamp: string,
    context: MessageCaptureContext
): void {
    if (!line.trim()) return;
    try {
        const message: JsonLineMessage = JSON.parse(line);
        if (message.type === 'assistant' || message.type === 'user') {
            const key = message.message?.id
                || `${message.type}-${JSON.stringify(message).substring(0, 100)}`;
            context.messageTimestamps.set(key, timestamp);
        }
        if (!context.state.sessionIdDetected && context.onSessionId && message.session_id) {
            context.state.sessionIdDetected = true;
            context.onSessionId(message.session_id, message.conversation_id);
        }
    } catch { /* Ignore non-JSON output lines. */ }
}

export function initRedisStreaming(
    taskId: string,
    stripAnsi: boolean | undefined,
    getStdout: () => string,
    state: RedisStreamingState
): void {
    (async () => {
        try {
            state.client = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: parseInt(process.env.REDIS_PORT || '6379', 10)
            });
            const redisKey = `agent:output:${taskId}`;
            state.interval = setInterval(() => {
                const stdout = getStdout();
                if (stdout.length > state.lastLen && state.client && !state.pendingWrite) {
                    const client = state.client;
                    const write = (async () => {
                        try {
                            await client.setex(
                                redisKey,
                                3600,
                                stripAnsi ? stripAnsiCodes(stdout) : stdout
                            );
                            state.lastLen = stdout.length;
                        } catch (err) {
                            logger.debug({ error: (err as Error).message },
                                'Failed to stream output to Redis');
                        }
                    })();
                    state.pendingWrite = write;
                    void write.finally(() => {
                        if (state.pendingWrite === write) state.pendingWrite = null;
                    });
                }
            }, 2000);
            logger.debug({ taskId, redisKey }, 'Started streaming output to Redis');
        } catch (err) {
            logger.warn({ error: (err as Error).message }, 'Failed to initialize Redis streaming');
        }
    })();
}

export function initTaskLivenessHeartbeat(taskId: string): ReturnType<typeof setInterval> {
    const heartbeat = async () => {
        try {
            const publisher = await getTaskEventPublisher();
            await publisher.projectTaskHeartbeat(taskId);
        } catch (err) {
            logger.debug({ error: (err as Error).message }, 'Failed to project task liveness heartbeat');
        }
    };
    void heartbeat();
    const interval = setInterval(() => { void heartbeat(); }, TASK_LIVENESS_HEARTBEAT_MS);
    interval.unref();
    return interval;
}

export function createTaskProgressReporter(taskId: string): () => void {
    let lastReportedAt = 0;
    return () => {
        const observedAt = Date.now();
        if (observedAt - lastReportedAt < TASK_LIVENESS_HEARTBEAT_MS) return;
        lastReportedAt = observedAt;
        void getTaskEventPublisher()
            .then(publisher => publisher.projectTaskProgress(
                taskId,
                new Date(observedAt).toISOString()
            ))
            .catch((err) => logger.debug(
                { error: (err as Error).message },
                'Failed to project observable task progress'
            ));
    };
}

export async function cleanupRedisStreaming(
    state: Pick<RedisStreamingState, 'client' | 'interval' | 'pendingWrite'> & {
        operationTimeoutMs?: number;
    },
    taskId: string | undefined,
    stripAnsi: boolean | undefined,
    stdout: string
): Promise<void> {
    const operationTimeoutMs = state.operationTimeoutMs ?? REDIS_STREAMING_CLEANUP_TIMEOUT_MS;
    if (state.interval) clearInterval(state.interval);
    const client = state.client;
    if (state.pendingWrite) {
        try {
            await withNotificationDeadline(
                state.pendingWrite,
                operationTimeoutMs,
                'draining Redis output stream write',
                () => client?.disconnect()
            );
        } catch (err) {
            logger.debug({ error: (err as Error).message },
                'Failed to drain Redis streaming write');
        }
    }
    if (client) {
        try {
            if (taskId) {
                await withNotificationDeadline(
                    client.setex(
                        `agent:output:${taskId}`,
                        3600,
                        stripAnsi ? stripAnsiCodes(stdout) : stdout
                    ),
                    operationTimeoutMs,
                    'writing final Redis output stream',
                    () => client.disconnect()
                );
            }
        } catch (err) {
            logger.debug({ error: (err as Error).message }, 'Failed to cleanup Redis streaming');
        } finally {
            try {
                await withNotificationDeadline(
                    client.quit(),
                    operationTimeoutMs,
                    'closing Redis output stream client',
                    () => client.disconnect()
                );
            } catch (err) {
                logger.debug({ error: (err as Error).message }, 'Failed to close Redis streaming client');
                client.disconnect();
            }
        }
    }
}

export function detectContainerId(
    worktreePath: string,
    state: ContainerDetectionState,
    onContainerId?: (containerId: string, containerName: string) => void
): void {
    setTimeout(() => {
        if (state.containerIdDetected) return;
        try {
            const output = execFileSync(
                '/usr/bin/docker',
                ['ps', '--filter', `volume=${worktreePath}`, '--format', '{{.ID}}:{{.Names}}', '--latest'],
                { encoding: 'utf8', timeout: 5000 }
            ).trim();
            if (!output) return;
            const [containerId, containerName] = output.split(':');
            state.containerIdDetected = true;
            state.containerId.value = containerId;
            onContainerId?.(containerId, containerName);
            logger.debug(
                { containerId, containerName, worktreePath },
                'Detected Docker container ID'
            );
        } catch (err) {
            logger.debug({ error: (err as Error).message }, 'Failed to detect container ID');
        }
    }, 2000);
}
