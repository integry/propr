/**
 * Child process for test/allInOneIdleHostStop.test.ts: the all-in-one exit
 * wiring (bounded exit, signal handlers, Fly Machine stop) around components
 * that close at once, with a keep-alive handle like an open Redis socket. On
 * "idle" on stdin it runs the idle stop exactly as src/allInOne.ts does; the
 * Machines API it calls is the test's local server (FLY_STOP_TEST_API_URL).
 */
import { createBoundedExit, installShutdownSignalHandlers } from '../../src/allInOneConfig.js';
import { resolveFlyMachineStop } from '../../src/flyMachineStop.js';

const keepAlive = setInterval(() => undefined, 1_000);
const log = { info: (message: string) => console.log(message), warn: (message: string) => console.log(message), error: (message: string, error?: unknown) => console.log(`${message}${error ? ` (${(error as Error).message})` : ''}`) };
const closeAndExit = createBoundedExit({
    close: async () => { clearInterval(keepAlive); return []; },
    exit: code => process.exit(code),
    pendingStep: () => null,
    log,
    deadlineMs: 5_000,
    hostStopTimeoutMs: Number(process.env.HOST_STOP_TEST_TIMEOUT_MS ?? 5_000),
});
installShutdownSignalHandlers({
    stop: signal => closeAndExit(0, { signal }),
    log,
    exit: code => process.exit(code),
    on: (signal, handler) => { process.on(signal, handler); },
});
const machineStop = resolveFlyMachineStop(process.env, { baseUrl: process.env.FLY_STOP_TEST_API_URL });
process.stdin.on('data', chunk => {
    if (!String(chunk).includes('idle')) return;
    console.log(`idle stop (${machineStop.kind})`);
    closeAndExit(0, { exitBy: null, stopHost: machineStop.kind === 'ready' ? machineStop.stop : null });
});
console.log('ready');
