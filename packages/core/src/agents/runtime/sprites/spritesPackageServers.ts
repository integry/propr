import type { Sprite } from '@fly/sprites';
import logger from '../../../utils/logger.js';
import { PACKAGE_SERVER_INSTALLER, PACKAGE_SERVER_INSTALL_TIMEOUT_MS, packageServerInstallSpec, packageServersLogFields,
    type RemotePackageInstall } from '../../../extensions/remotePackageServers.js';

/**
 * Install the run's package (stdio) MCP servers on a Sprite being provisioned,
 * before its clean checkpoint, so every run restored from it has them. A
 * failed or timed-out install fails provisioning with the end of npm's output.
 * Returns the install time, or undefined when there is nothing to install.
 */
export async function installSpritePackageServers({ sprite, dir, install, step, signal }: { sprite: Sprite; dir: string;
    install: RemotePackageInstall | undefined; step: <T>(operation: () => Promise<T>) => Promise<T>; signal: AbortSignal }): Promise<number | undefined> {
    if (!install?.servers.length) return undefined;
    const fs = sprite.filesystem();
    const installer = dir + '/package-servers.py';
    const spec = dir + '/package-servers.json';
    await step(() => fs.writeFile(installer, PACKAGE_SERVER_INSTALLER));
    await step(() => fs.writeFile(spec, packageServerInstallSpec(install), { mode: 0o600 }));
    const started = Date.now();
    // The installer bounds npm itself; the exec limit is a backstop for a lost Sprite.
    await step(() => sprite.execFile('sudo', ['-n', '/usr/bin/python3', '-I', installer, spec],
        { cwd: '/', signal, timeout: PACKAGE_SERVER_INSTALL_TIMEOUT_MS + 60_000 }));
    const installMs = Date.now() - started;
    logger.info({ sprite: sprite.name, ...packageServersLogFields(install.servers), installMs }, 'Installed package MCP servers on Sprite');
    return installMs;
}
