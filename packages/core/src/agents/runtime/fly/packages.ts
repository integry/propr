import { AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS, agentRuntimePackageInstallCommand, agentRuntimePackagesLogFields } from '../agentRuntimePackageProfile.js';
import logger from '../../../utils/logger.js';
import { formatComputeDuration } from '../computeUsage.js';
import type { MachinesApi } from './api.js';
import { RUN } from './wrapper.js';

/** `PATH` for root processes on a Fly Machine: the agent launch, its start-time install and the image build Machine. */
export const FLY_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The install the wrapper runs as root (`packages.json` at Machine start, `build.json` on an image build Machine).
 * One builder for both, so the derived image and the start-time fallback install the same way.
 */
export function flyPackageInstallSpec(packages: readonly string[]) {
    return { argv: agentRuntimePackageInstallCommand(packages), path: FLY_PATH, timeout: AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS };
}

/** What the Machine's wrapper recorded for the runtime package install it ran before the agent. */
export interface FlyPackageInstall { ms: number; code: number | 'timeout'; tail: string }

/** Reads the install record; undefined when the Machine cannot be reached or wrote none. */
export async function readFlyPackageInstall(api: MachinesApi, id: string, signal?: AbortSignal): Promise<FlyPackageInstall | undefined> {
    const res = await api.exec(id, ['/bin/cat', RUN + '/packages-result'], signal).catch(() => undefined);
    if (res?.exit_code !== 0) return;
    try {
        const parsed = JSON.parse(res.stdout) as Partial<FlyPackageInstall>;
        if (typeof parsed.ms !== 'number' || !Number.isFinite(parsed.ms) || parsed.ms < 0) return;
        const code = parsed.code === 'timeout' || Number.isSafeInteger(parsed.code) ? parsed.code as number | 'timeout' : -1;
        return { ms: parsed.ms, code, tail: typeof parsed.tail === 'string' ? parsed.tail : '' };
    } catch { return; }
}

/** One log line per Fly run that installed packages: digest and duration, names only for a short list. */
export function logFlyPackageInstall(run: string, machine: string, packages: readonly string[], install: FlyPackageInstall | undefined) {
    const fields = { run, machine, ...agentRuntimePackagesLogFields(packages), installMs: install?.ms ?? null };
    if (install?.code === 0) logger.info(fields, 'Installed agent runtime packages at Fly Machine start');
    else if (!install) logger.warn(fields, 'Could not read the agent runtime package install record from the Fly Machine');
    else logger.warn({ ...fields, exitCode: install.code }, 'Agent runtime package install failed at Fly Machine start');
}

/** The run's failure when the Machine could not install the packages, with the end of apt's output. */
export function flyPackageInstallError(packages: readonly string[], install: FlyPackageInstall | undefined): Error {
    const { packagesDigest } = agentRuntimePackagesLogFields(packages);
    const outcome = !install ? 'did not report a result'
        : install.code === 'timeout' ? `timed out after ${formatComputeDuration(install.ms)}`
        : `exited with code ${install.code} after ${formatComputeDuration(install.ms)}`;
    const tail = install?.tail.trim();
    return new Error(`Fly Machine could not install the agent runtime packages (digest ${packagesDigest}): apt ${outcome}. `
        + 'The run was not started without them; check the package names in Settings, or use Sprites.'
        + (tail ? `\n${tail}` : ''));
}
