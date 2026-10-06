import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import fs from 'fs';
import logger from '../../utils/logger.js';

/**
 * Spawns an execution's process. `stdinData` is written and stdin closed,
 * unless `liveInput` keeps stdin open for a live input channel to write.
 */
export function spawnCommandProcess(options: {
    executablePath: string;
    args: string[];
    cwd: string | undefined;
    stdinData: string | undefined;
    liveInput?: boolean;
}): ChildProcess {
    const { executablePath, args, cwd, stdinData, liveInput = false } = options;
    const spawnOptions: SpawnOptions = { stdio: [stdinData || liveInput ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: process.env };
    if (cwd && fs.existsSync(cwd)) spawnOptions.cwd = cwd;
    else if (cwd) logger.warn({ cwd }, 'Working directory does not exist, spawning from current directory');

    const child = spawn(executablePath, args, spawnOptions);
    if (stdinData && child.stdin && !liveInput) {
        child.stdin.on('error', (err) => { logger.warn({ error: err.message, code: (err as NodeJS.ErrnoException).code }, 'Stdin write error'); });
        child.stdin.write(stdinData);
        child.stdin.end();
        logger.debug({ stdinDataLength: stdinData.length }, 'Wrote prompt data to stdin');
    }
    return child;
}
