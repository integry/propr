import type { ExtensionLibraryPackageServer, ExtensionSkippedItem, ResolvedExtensionSet } from '@propr/shared';
import type { AgentExtensionRequest } from '../agents/types.js';
import logger from '../utils/logger.js';
import { ExtensionPackageCache, ExtensionPackageError, type InstalledPackage } from './packageCache.js';

/** Where a run's package servers are mounted, read-only, in the task container. */
export const PACKAGE_MOUNT_ROOT = '/opt/propr/packages';
export const isPackageServer = (server: { kind: string }): server is ExtensionLibraryPackageServer => server.kind === 'package';

/**
 * Install (once per integrity value) and verify the run's package servers.
 * A server that cannot be installed, or whose installed files no longer match
 * its integrity value, is refused: the run proceeds without it and the
 * resolution event records the reason.
 */
export async function preparePackageServers(set: ResolvedExtensionSet, request: AgentExtensionRequest, cache: ExtensionPackageCache): Promise<{ set: ResolvedExtensionSet; installed: Map<string, InstalledPackage> }> {
  const installed = new Map<string, InstalledPackage>();
  const refused: ExtensionSkippedItem[] = [];
  for (const server of set.servers.filter(isPackageServer)) {
    try { installed.set(server.name, await cache.ensure(server)); }
    catch (error) {
      const reason = error instanceof ExtensionPackageError ? error.reason : 'package_unavailable';
      // Fixed fields only: install output and file system errors can name private paths.
      logger.warn({ server: server.name, package: server.package, version: server.version, reason }, 'Package MCP server refused for this run');
      refused.push({ kind: 'server', name: server.name, reason, source: request.servers.includes(server.name) ? 'additional' : 'auto' });
    }
  }
  if (!refused.length) return { set, installed };
  const names = new Set(refused.map(item => item.name));
  return { set: { ...set, servers: set.servers.filter(s => !names.has(s.name)), skipped: [...set.skipped, ...refused] }, installed };
}

/**
 * The stdio bridge configuration of one package server: Node runs the
 * package's executable from its read-only mount with the fixed arguments.
 * Plain variables travel in the configuration; secret values only through
 * the environment names in `secretEnv`.
 */
export function packageBridgeConfig(server: ExtensionLibraryPackageServer, installed: InstalledPackage, mount: string, secretEnv: Record<string, string>) {
  return {
    name: server.name, executable: '/usr/local/bin/node', args: [`${mount}/${installed.entry}`, ...server.args], tools: server.tools,
    env: Object.fromEntries(server.env.map(variable => [variable.name, variable.value])), secretEnv,
  };
}
/** Read-only bind mount of one installed package. */
export const packageMount = (installed: InstalledPackage, target: string) => ['--mount', `type=bind,source=${installed.hostDirectory},target=${target},readonly,bind-recursive=disabled`];
