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
    options: Pick<DockerCommandOptions, 'taskId' | 'streamToRedis' | 'streamStderrToRedis' | 'streamExtraOutput' | 'stripAnsi'> & { onOverflow: (error: Error) => void; onActivity?: () => void; onTranscriptRecord?: (record: string) => void },
    readStdout: () => string,
    readStderr: () => string,
): LiveOutputStreaming | null {
    const { taskId, streamToRedis, streamStderrToRedis, streamExtraOutput, stripAnsi, onOverflow, onActivity, onTranscriptRecord } = options;
    if (!streamToRedis || !taskId) return null;
    const log = new LiveOutputLog(taskId, { reset: true, onOverflow, ...(stripAnsi ? { transformRecord: stripAnsiCodes } : {}) });
    if (!streamExtraOutput) {
        return { stdout: chunk => log.append(chunk, 'stdout'), stderr: chunk => { if (streamStderrToRedis) log.append(chunk, 'stderr'); }, close: () => log.close() };
    }
    let previous = '';
    // Length of the transcript's complete records already handed to onTranscriptRecord.
    let observedLength = 0;
    const observeTranscript = (transcript: string) => {
        // A shorter transcript is a new session file; its records are new.
        if (transcript.length < observedLength) observedLength = 0;
        const end = transcript.lastIndexOf('\n') + 1;
        if (end <= observedLength) return;
        const records = transcript.slice(observedLength, end).split('\n');
        observedLength = end;
        for (const record of records) if (record.trim()) onTranscriptRecord?.(record);
    };
    const publish = () => {
        let extraOutput = '';
        try { extraOutput = streamExtraOutput(); }
        catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to read extra streaming output'); }
        observeTranscript(extraOutput);
        const snapshot = buildLiveOutputSnapshot(extraOutput, readStdout(), streamStderrToRedis ? readStderr() : '');
        if (snapshot.text !== previous) {
            log.replace(snapshot.text, { discarded: snapshot.discarded });
            // Snapshot providers (Vibe) may say nothing on stdout; a changed transcript is activity,
            // and its new records carry the tool calls the watchdog's thresholds depend on.
            onActivity?.();
        }
        previous = snapshot.text;
    };
    const interval = setInterval(publish, 2000);
    return {
        stdout: () => undefined,
        stderr: () => undefined,
        close: async () => { clearInterval(interval); publish(); await log.close(); },
    };
}
