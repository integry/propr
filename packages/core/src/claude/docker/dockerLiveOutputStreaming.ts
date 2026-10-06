import logger from '../../utils/logger.js';
import { LiveOutputLog } from '../../agents/impl/utils/liveOutputLog.js';
import { buildLiveOutputSnapshot } from './dockerLiveOutputSnapshot.js';
import type { DockerCommandOptions } from './dockerExecutor.js';

// ANSI escape code regex for stripping terminal formatting (constructed dynamically to avoid control char lint errors)
const ANSI_REGEX = new RegExp('[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b) + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');

function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_REGEX, '');
}

export interface LiveOutputStreaming { stdout(chunk: string): void; stderr(chunk: string): void; close(): Promise<void> }

/**
 * The task's live log is append-only: each record is sent once, as it arrives,
 * and a new execution replaces what an earlier one left. Providers whose
 * readable transcript only exists as a whole snapshot (Vibe's session
 * messages) publish that snapshot in place of the previous one instead.
 */
export function startLiveOutputStreaming(
    options: Pick<DockerCommandOptions, 'taskId' | 'streamToRedis' | 'streamStderrToRedis' | 'streamExtraOutput' | 'stripAnsi'> & { onOverflow: (error: Error) => void },
    readStdout: () => string,
    readStderr: () => string,
): LiveOutputStreaming | null {
    const { taskId, streamToRedis, streamStderrToRedis, streamExtraOutput, stripAnsi, onOverflow } = options;
    if (!streamToRedis || !taskId) return null;
    const log = new LiveOutputLog(taskId, { reset: true, onOverflow, ...(stripAnsi ? { transformRecord: stripAnsiCodes } : {}) });
    if (!streamExtraOutput) {
        return { stdout: chunk => log.append(chunk, 'stdout'), stderr: chunk => { if (streamStderrToRedis) log.append(chunk, 'stderr'); }, close: () => log.close() };
    }
    let previous = '';
    const publish = () => {
        let extraOutput = '';
        try { extraOutput = streamExtraOutput(); }
        catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to read extra streaming output'); }
        const snapshot = buildLiveOutputSnapshot(extraOutput, readStdout(), streamStderrToRedis ? readStderr() : '');
        if (snapshot.text !== previous) log.replace(snapshot.text, { discarded: snapshot.discarded });
        previous = snapshot.text;
    };
    const interval = setInterval(publish, 2000);
    return {
        stdout: () => undefined,
        stderr: () => undefined,
        close: async () => { clearInterval(interval); publish(); await log.close(); },
    };
}
