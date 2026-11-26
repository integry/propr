import { PACKAGE_SERVER_INSTALL_TIMEOUT_MS, type RemotePackageServer } from '../../../extensions/remotePackageServers.js';
import { AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS } from '../agentRuntimePackageProfile.js';
import type { MachinesApi } from './api.js';
import { PACKAGE_SERVERS } from './launch.js';
import { flyPackageInstallError, logFlyPackageInstall, readFlyPackageInstall, type FlyPackageInstall } from './packages.js';
import { flyPackageServerInstallError, logFlyPackageServerInstall, readFlyPackageServerInstall, type FlyPackageServerInstall } from './packageServers.js';
import { RUN } from './wrapper.js';

/** How long the worker tolerates failed status probes before it treats the Machine as unreachable. */
export const POLL_FAILURE_TOLERANCE = 15_000;
/** The package server installer bounds npm; a Machine reporting `installing` for it is waited for up to this longer. */
const PACKAGE_SERVER_INSTALL_WAIT_MS = PACKAGE_SERVER_INSTALL_TIMEOUT_MS + 60_000 + POLL_FAILURE_TOLERANCE;
const RUNTIME_PACKAGE_INSTALL_WAIT_MS = AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS + POLL_FAILURE_TOLERANCE;

/** States in which the agent has not started: the Machine is installing (runtime packages or package servers) or waiting for the start gate. */
const NOT_STARTED = ['ready', 'installing', 'install-failed'];

/** Ready after an install: the guest opens a fresh boot window for the start gate, so the worker waits for it too. */
export const afterInstall = (deadline: number, installed: boolean, bootTimeout: number) => installed ? Math.max(deadline, Date.now() + bootTimeout) : deadline;

/** The last status probe's outcome: a failed install, the agent's exit code or `running`; undefined while it has not started. */
export function lastProbeOutcome(last: RegExpExecArray | null | false | undefined) {
    if (!last) return undefined;
    if (last[1] === 'install-failed') return 'install-failed';
    if (!NOT_STARTED.includes(last[1])) return last[2] === undefined ? 'running' : Number(last[2]);
}

/**
 * What a Fly Machine installs as root at start, before the agent and the start gate: the instance
 * runtime packages first, then the run's package MCP servers (which may need them). Tracks the
 * install records the Machine wrote, for the run's log, its compute usage and an install failure.
 */
export class FlyStartInstalls {
    private packageInstall: FlyPackageInstall | undefined;
    private packageServerInstall: FlyPackageServerInstall | undefined;

    constructor(private readonly run: string, private readonly packages: readonly string[], private readonly servers: readonly RemotePackageServer[]) {}

    /** Latest time the installs may still be running; the boot deadline without either. */
    installDeadline(bootDeadline: number) {
        return bootDeadline + (this.packages.length ? RUNTIME_PACKAGE_INSTALL_WAIT_MS : 0) + (this.servers.length ? PACKAGE_SERVER_INSTALL_WAIT_MS : 0);
    }

    /** Reads and logs each install's record once the Machine reports ready, before the start gate opens. */
    async readCompleted(api: MachinesApi, machine: string, signal: AbortSignal) {
        if (this.packages.length && !this.packageInstall) {
            this.packageInstall = await readFlyPackageInstall(api, machine, signal);
            logFlyPackageInstall(this.run, machine, this.packages, this.packageInstall);
        }
        if (this.servers.length && !this.packageServerInstall) {
            this.packageServerInstall = await readFlyPackageServerInstall(api, machine, signal);
            logFlyPackageServerInstall(this.run, machine, this.servers, this.packageServerInstall);
        }
    }

    /**
     * The run's failure after the Machine reported `install-failed`: a failed or unreported runtime
     * package install (it runs first), else the package servers. Acknowledges the record so the
     * Machine exits without waiting out its window.
     */
    async failure(api: MachinesApi, machine: string): Promise<Error> {
        const runtimeInstall = this.packages.length ? await readFlyPackageInstall(api, machine, AbortSignal.timeout(5000)) : undefined;
        if (!this.servers.length || (this.packages.length > 0 && runtimeInstall?.code !== 0)) {
            logFlyPackageInstall(this.run, machine, this.packages, runtimeInstall);
            void api.exec(machine, ['/usr/bin/touch', RUN + '/packages-read']).catch(() => {});
            return flyPackageInstallError(this.packages, runtimeInstall);
        }
        const serverInstall = await readFlyPackageServerInstall(api, machine, AbortSignal.timeout(5000));
        logFlyPackageServerInstall(this.run, machine, this.servers, serverInstall);
        void api.exec(machine, ['/usr/bin/touch', PACKAGE_SERVERS.read]).catch(() => {});
        return flyPackageServerInstallError(this.servers, serverInstall);
    }

    /** Each install's time as its own compute usage field. */
    usage() {
        return { ...(this.packageInstall && { packageInstallMs: this.packageInstall.ms }),
            ...(this.packageServerInstall && { packageServerInstallMs: this.packageServerInstall.ms }) };
    }
}
