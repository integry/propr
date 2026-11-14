import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import {
  EXTENSION_LIMITS, extensionPackageBinSchema, extensionPackageIntegritySchema, extensionPackageNameSchema, extensionPackageVersionSchema,
  type ExtensionPackageResolution,
} from '@propr/shared';
import { resolveExtensionEndpoint } from './endpointPolicy.js';
import { ExtensionError } from './extensionProfileStore.js';

/** The public npm registry. Private registries and registry credentials are out of scope. */
export const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';
const MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * The registry package servers resolve and install from: the public npm
 * registry, or an operator-configured mirror of it
 * (`PROPR_EXTENSION_NPM_REGISTRY`). A mirror is operator configuration, like
 * the catalog file, so it is not held to the public-address rule.
 */
export function npmRegistryUrl(environment: NodeJS.ProcessEnv = process.env): { url: string; operator: boolean } {
  const configured = environment.PROPR_EXTENSION_NPM_REGISTRY?.trim();
  if (!configured) return { url: PUBLIC_NPM_REGISTRY, operator: false };
  let url: URL; try { url = new URL(configured); } catch { throw new ExtensionError(503, 'The configured npm registry URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ExtensionError(503, 'The configured npm registry URL must be credential-free');
  return { url: url.toString().replace(/\/+$/, ''), operator: true };
}

/** One bounded GET without redirects, cookies or credentials. The public registry is dialled only at its vetted address. */
async function registryGet(target: string, operator: boolean): Promise<{ status: number; body: Buffer }> {
  const url = new URL(target);
  let options: https.RequestOptions = {};
  if (!operator) {
    // The public registry is HTTPS on 443 and must resolve to public addresses only.
    const { address, family } = await resolveExtensionEndpoint(`${url.origin}${url.pathname}`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    options = { servername: isIP(host) ? undefined : host, lookup: (_host, _options, callback) => callback(null, address, family) };
  }
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const unavailable = () => reject(new ExtensionError(502, 'Package registry unavailable'));
    const request = transport.request(url, { ...options, method: 'GET', agent: false, headers: { Accept: 'application/json' } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MANIFEST_BYTES) { response.destroy(); unavailable(); } else chunks.push(chunk); });
      response.on('error', unavailable);
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => { request.destroy(); unavailable(); }, EXTENSION_LIMITS.timeoutMs);
    request.on('close', () => clearTimeout(timer)); request.on('error', unavailable); request.end();
  });
}

/** A relative path inside the package; never absolute, never leaving it. */
function packageRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') || value.includes('\\')) return null;
  const normalized = path.posix.normalize(value);
  if (path.posix.isAbsolute(normalized) || normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}
/** The executables a package manifest declares, by name, with their path inside the package. */
export function packageBins(name: string, bin: unknown): Record<string, string> {
  const entries: [string, unknown][] = typeof bin === 'string' ? [[name.replace(/^@[^/]+\//, ''), bin]] : bin && typeof bin === 'object' && !Array.isArray(bin) ? Object.entries(bin) : [];
  const bins: Record<string, string> = {};
  for (const [key, file] of entries) {
    const relative = packageRelativePath(file);
    if (relative && extensionPackageBinSchema.safeParse(key).success) bins[key] = relative;
  }
  return bins;
}
/** The executable to run: the one named, the only one, or the one named after the package. */
export function selectPackageBin(name: string, bins: Record<string, string>, wanted?: string): string {
  const names = Object.keys(bins).sort();
  if (!names.length) throw new ExtensionError(400, 'The package declares no executable, so it cannot run as a local MCP server');
  if (wanted !== undefined) {
    if (!Object.hasOwn(bins, wanted)) throw new ExtensionError(400, `The package has no executable named ${wanted}; it declares ${names.join(', ')}`);
    return wanted;
  }
  if (names.length === 1) return names[0];
  const own = name.replace(/^@[^/]+\//, '');
  if (Object.hasOwn(bins, own)) return own;
  throw new ExtensionError(400, `The package declares several executables (${names.join(', ')}); choose one`);
}

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/**
 * Look one exact package version up in the registry and record its integrity
 * value. Nothing is downloaded or executed. Packages that need install
 * scripts are unsupported: installs never run them.
 */
export async function resolveNpmPackage(input: { package: unknown; version: unknown; bin?: unknown }, environment: NodeJS.ProcessEnv = process.env): Promise<ExtensionPackageResolution & { bins: string[]; binPath: string }> {
  const name = extensionPackageNameSchema.safeParse(input.package);
  if (!name.success) throw new ExtensionError(400, 'Enter an npm package name');
  const version = extensionPackageVersionSchema.safeParse(input.version);
  if (!version.success) throw new ExtensionError(400, 'Enter an exact version such as 1.2.3; ranges and tags are not accepted');
  if (input.bin !== undefined && !extensionPackageBinSchema.safeParse(input.bin).success) throw new ExtensionError(400, 'Invalid executable name');
  const registry = npmRegistryUrl(environment);
  const response = await registryGet(`${registry.url}/${name.data}/${version.data}`, registry.operator);
  if (response.status === 404) throw new ExtensionError(404, `${name.data}@${version.data} was not found in the npm registry`);
  if (response.status !== 200) throw new ExtensionError(502, 'Package registry unavailable');
  let manifest: { name?: unknown; version?: unknown; dist?: { integrity?: unknown }; bin?: unknown; scripts?: Record<string, unknown>; gypfile?: unknown };
  try { manifest = JSON.parse(response.body.toString('utf8')); } catch { throw new ExtensionError(502, 'Package registry unavailable'); }
  if (!manifest || manifest.name !== name.data || manifest.version !== version.data) throw new ExtensionError(502, 'The registry returned a different package or version');
  const integrity = extensionPackageIntegritySchema.safeParse(manifest.dist?.integrity);
  if (!integrity.success) throw new ExtensionError(400, 'The registry has no SHA-512 integrity value for this version, so it cannot be pinned');
  if (manifest.gypfile === true || LIFECYCLE_SCRIPTS.some(script => typeof manifest.scripts?.[script] === 'string')) throw new ExtensionError(400, 'This package needs install scripts, which ProPR never runs; it is unsupported');
  const bins = packageBins(name.data, manifest.bin);
  const bin = selectPackageBin(name.data, bins, input.bin as string | undefined);
  return { ecosystem: 'npm', package: name.data, version: version.data, integrity: integrity.data, bin, bins: Object.keys(bins).sort(), binPath: bins[bin] };
}
