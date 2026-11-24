/**
 * Child process for test/allInOneConfig.test.ts: installs the all-in-one
 * shutdown handlers around a drain that never finishes, with a keep-alive
 * handle (like an open Redis socket or HTTP server), and reports readiness.
 */
import { installShutdownSignalHandlers } from '../../src/allInOneConfig.js';

const keepAlive = setInterval(() => undefined, 1_000);
installShutdownSignalHandlers({
    close: () => new Promise<string[]>(() => { void keepAlive; }),
    timeoutMs: Number(process.env.PROPR_SHUTDOWN_TIMEOUT_MS),
    log: { info: message => console.log(message), warn: message => console.log(message), error: message => console.log(message) },
    exit: code => process.exit(code),
    on: (signal, handler) => { process.on(signal, handler); },
});
console.log('ready');
