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
