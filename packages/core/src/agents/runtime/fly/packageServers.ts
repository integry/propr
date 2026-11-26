import { setTimeout as delay } from 'node:timers/promises';
import logger from '../../../utils/logger.js';
import { formatComputeDuration } from '../computeUsage.js';
import { packageServersLogFields, type RemotePackageServer } from '../../../extensions/remotePackageServers.js';
import type { MachinesApi } from './api.js';
import { PACKAGE_SERVERS } from './launch.js';

/** What the Machine's wrapper recorded for the package server install it ran before the agent. */
export interface FlyPackageServerInstall { ms: number; code: number | 'timeout'; tail: string }

/** Reads the install record; undefined when the Machine cannot be reached or wrote none. */
export async function readFlyPackageServerInstall(api: MachinesApi, id: string, signal?: AbortSignal): Promise<FlyPackageServerInstall | undefined> {
    const res = await api.exec(id, ['/bin/cat', PACKAGE_SERVERS.result], signal).catch(() => undefined);
    if (res?.exit_code !== 0) return;
    try {
        const parsed = JSON.parse(res.stdout) as Partial<FlyPackageServerInstall>;
        if (typeof parsed.ms !== 'number' || !Number.isFinite(parsed.ms) || parsed.ms < 0) return;
        const code = parsed.code === 'timeout' || Number.isSafeInteger(parsed.code) ? parsed.code as number | 'timeout' : -1;
        return { ms: parsed.ms, code, tail: typeof parsed.tail === 'string' ? parsed.tail : '' };
    } catch { return; }
}

/** One log line per Fly run that installed package servers: digest, count and duration. */
export function logFlyPackageServerInstall(run: string, machine: string, servers: readonly RemotePackageServer[], install: FlyPackageServerInstall | undefined) {
    const fields = { run, machine, ...packageServersLogFields(servers), installMs: install?.ms ?? null };
    if (install?.code === 0) logger.info(fields, 'Installed package MCP servers at Fly Machine start');
    else if (!install) logger.warn(fields, 'Could not read the package MCP server install record from the Fly Machine');
    else logger.warn({ ...fields, exitCode: install.code }, 'Package MCP server install failed at Fly Machine start');
}

/** The run's failure when the Machine could not install the package servers, with the end of npm's output. */
export function flyPackageServerInstallError(servers: readonly RemotePackageServer[], install: FlyPackageServerInstall | undefined): Error {
    const { packageServersDigest } = packageServersLogFields(servers);
    const outcome = !install ? 'did not report a result'
        : install.code === 'timeout' ? `timed out after ${formatComputeDuration(install.ms)}`
        : `exited with code ${install.code} after ${formatComputeDuration(install.ms)}`;
    const tail = install?.tail.trim();
    return new Error(`Fly Machine could not install the run's package MCP servers (${servers.map(s => `${s.package}@${s.version}`).join(', ')}; digest ${packageServersDigest}): `
        + `npm ${outcome}. The agent was not started without them; check that the Machine can reach the npm registry, or remove the servers from the run.`
        + (tail ? `\n${tail}` : ''));
}

/**
 * Poll while the Machine installs package servers, before it reports ready.
 * The installer bounds itself; the deadline follows it, `tolerance` past the
 * last `installing` report, up to `installDeadline`. Returns the deadline for
 * the boot wait that follows, or failed.
 */
export async function waitForPackageServerInstall(state: (signal: AbortSignal) => Promise<string | undefined>, forced: AbortSignal,
    { bootDeadline, installDeadline, tolerance }: { bootDeadline: number; installDeadline: number; tolerance: number }) {
    let deadline = bootDeadline;
    while (!forced.aborted && Date.now() < deadline) {
        const current = await state(AbortSignal.any([forced, AbortSignal.timeout(deadline - Date.now())]));
        if (current === 'install-failed') return { failed: true, deadline };
        if (current === 'installing') deadline = Math.max(deadline, Math.min(Date.now() + tolerance, installDeadline));
        else if (current) return { failed: false, deadline };
        await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal: forced }).catch(() => {});
    }
    return { failed: false, deadline };
}
