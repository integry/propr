import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { normalizeEgressHost, type EgressAllowlist } from '../network/egressAllowlist.js';
import { startEgressProxy, upstreamProxiesFromEnv, type EgressLookup, type EgressProxyStats } from '../network/egressProxy.js';
import { npmRegistryUrl } from './packageRegistry.js';

/**
 * Where a worker-side package install may connect: the configured registry's
 * host and port, nothing else. Dependency metadata (tarball URLs, redirects,
 * git or hosted-git sources) cannot widen it. The public registry must resolve
 * to public addresses; an operator mirror is deliberate operator
 * configuration, like the catalog file, so its own addresses may be private.
 */
export function packageInstallEgressPolicy(environment: NodeJS.ProcessEnv = process.env): { registry: string; allowlist: EgressAllowlist; addressAllowlist: EgressAllowlist } {
  const registry = npmRegistryUrl(environment);
  const url = new URL(registry.url);
  const host = normalizeEgressHost(url.hostname);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const entry = `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  return {
    registry: registry.url,
    allowlist: { entries: [entry], allows: (candidate, candidatePort) => normalizeEgressHost(candidate) === host && candidatePort === port },
    // Consulted only for addresses of a host the allowlist already admitted: the mirror itself.
    addressAllowlist: registry.operator ? { entries: [entry], allows: (_address, candidatePort) => candidatePort === port } : { entries: [], allows: () => false },
  };
}

/** A loopback HTTP proxy for one npm install, enforcing {@link packageInstallEgressPolicy}. */
export interface PackageInstallProxy {
  /** `http://127.0.0.1:<port>`, for npm's `--proxy` and `--https-proxy`. */
  readonly url: string;
  /** The registry URL every installed dependency must be resolved from. */
  readonly registry: string;
  stats(): EgressProxyStats;
  close(): Promise<void>;
}

/**
 * Start the install proxy: the worker's egress proxy (it resolves names here,
 * dials only the vetted address and chains through the worker's own proxy)
 * behind a loopback TCP listener npm can use. Every request npm makes,
 * including each redirect hop, passes through it.
 */
export async function startPackageInstallProxy(environment: NodeJS.ProcessEnv = process.env, options: { lookup?: EgressLookup } = {}): Promise<PackageInstallProxy> {
  const policy = packageInstallEgressPolicy(environment);
  // A private directory: the socket itself is world-connectable.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-npm-egress-'));
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  let proxy: Awaited<ReturnType<typeof startEgressProxy>> | undefined;
  const bridge = net.createServer(client => {
    track(client);
    const upstream = net.connect(proxy!.socketPath); track(upstream);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('error', end); upstream.on('error', end); client.once('close', end); upstream.once('close', end);
    client.pipe(upstream).pipe(client);
  });
  try {
    proxy = await startEgressProxy({ socketPath: path.join(directory, 'proxy.sock'), allowlist: policy.allowlist, addressAllowlist: policy.addressAllowlist, upstreamProxies: upstreamProxiesFromEnv(environment), lookup: options.lookup });
    await new Promise<void>((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', () => { bridge.off('error', reject); resolve(); }); });
  } catch (error) {
    bridge.close(); await proxy?.close(); await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  const started = proxy;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${(bridge.address() as net.AddressInfo).port}`,
    registry: policy.registry,
    stats: () => started.stats(),
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>(resolve => bridge.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        await closed; await started.close(); await fs.rm(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}

type LockEntry = { resolved?: unknown; integrity?: unknown; link?: unknown; inBundle?: unknown };
/**
 * Every installed dependency must come from the registry, with an integrity
 * value: no URL, file, link or git sources. Bundled dependencies ship inside a
 * registry tarball and are covered by its integrity.
 */
export function assertRegistryDependencies(lock: { packages?: Record<string, LockEntry> }, registry: string): void {
  const prefix = `${registry.replace(/\/+$/, '')}/`;
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!location || entry.inBundle === true) continue;
    if (entry.link === true || typeof entry.resolved !== 'string' || !entry.resolved.startsWith(prefix) || typeof entry.integrity !== 'string' || !entry.integrity) {
      throw new Error(`Dependency ${location} does not come from the package registry`);
    }
  }
}
