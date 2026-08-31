import fs from 'fs';
import logger from '../../utils/logger.js';

// ANSI escape code regex for stripping terminal formatting (constructed dynamically to avoid control char lint errors)
const ANSI_REGEX = new RegExp('[' + String.fromCharCode(0x1b) + String.fromCharCode(0x9b) + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');

export function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_REGEX, '');
}

export function resolveDockerPath(command: string): string {
    if (command !== 'docker') return command;
    const paths = ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'];
    for (const p of paths) {
        try { if (fs.existsSync(p)) { fs.accessSync(p, fs.constants.X_OK); logger.debug({ dockerPath: p }, 'Found docker executable'); return p; } } catch { /* continue */ }
    }
    logger.debug('Using docker from PATH');
    return 'docker';
}
