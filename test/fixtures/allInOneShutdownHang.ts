/**
 * Child process for test/allInOneConfig.test.ts: installs the all-in-one
 * shutdown handlers around a drain that never finishes, with a keep-alive
 * handle (like an open Redis socket or HTTP server), and reports readiness.
 */
import { createBoundedExit, installShutdownSignalHandlers, resolveShutdownTimeoutMs } from '../../src/allInOneConfig.js';

const keepAlive = setInterval(() => undefined, 1_000);
const log = { info: (message: string) => console.log(message), warn: (message: string) => console.log(message), error: (message: string) => console.log(message) };
const closeAndExit = createBoundedExit({
    close: () => new Promise<string[]>(() => { void keepAlive; }),
    exit: code => process.exit(code),
    pendingStep: () => 'api',
    log,
    deadlineMs: resolveShutdownTimeoutMs(process.env.PROPR_SHUTDOWN_TIMEOUT_MS),
});
installShutdownSignalHandlers({
    stop: signal => closeAndExit(0, { signal }),
    log,
    exit: code => process.exit(code),
    on: (signal, handler) => { process.on(signal, handler); },
});
console.log('ready');
