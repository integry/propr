#!/usr/bin/env node
import fs from 'node:fs';

const statePath = process.env.GOAL_PENDING_OPEN_STATE;
const logPath = process.env.GOAL_PENDING_OPEN_LOG;
const expected = JSON.parse(process.env.GOAL_PENDING_OPEN_LABELS ?? '{}');
const args = process.argv.slice(2);
if (!statePath || !logPath) process.exit(2);
fs.appendFileSync(logPath, `${JSON.stringify(args)}\n`);

if (args[0] === 'ps') {
    const filters = args.flatMap((argument, index) => argument === '--filter' ? [args[index + 1]] : []);
    const matches = Object.entries(expected).every(([name, value]) => filters.includes(`label=${name}=${value}`));
    if (matches && fs.existsSync(statePath)) process.stdout.write(`${fs.readFileSync(statePath, 'utf8').trim()}\n`);
    process.exit(0);
}
if (args[0] === 'rm' && args[1] === '-f' && args[2]) {
    try { fs.unlinkSync(statePath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    process.exit(0);
}
process.exit(2);
