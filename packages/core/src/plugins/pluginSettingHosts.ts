import dns from 'node:dns/promises';
import { pluginHttpsUrlHost, validatePluginSettings, type PluginManifest, type PluginSettingValues } from '@propr/shared';
import { extensionPublicAddress, extensionReservedHostname, type ExtensionLookup } from '../extensions/endpointPolicy.js';

/** How long one save-time lookup may take. */
const LOOKUP_TIMEOUT_MS = 10_000;
const defaultLookup: ExtensionLookup = host => dns.lookup(host, { all: true, verbatim: true });

/** Why `host` is not a public endpoint (named after `key`, so the Plugins page shows it on the field), or null. */
async function hostProblem(key: string, host: string, lookup: ExtensionLookup): Promise<string | null> {
  if (extensionReservedHostname(host)) return `${key} must point to a public address, not the local name ${host}`;
  let timer: NodeJS.Timeout | undefined;
  let addresses: Awaited<ReturnType<ExtensionLookup>>;
  try {
    addresses = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), LOOKUP_TIMEOUT_MS); timer.unref(); }),
    ]);
  } catch {
    return `${key} could not be checked: ${host} could not be resolved`;
  } finally { clearTimeout(timer); }
  if (!addresses.length) return `${key} could not be checked: ${host} could not be resolved`;
  if (!addresses.every(a => extensionPublicAddress(a.address))) return `${key} must point to a public address: ${host} resolves to a private, loopback or reserved address`;
  return null;
}

/**
 * The save-time check of the URL settings a manifest's
 * `outboundHostsFromSettings` names: each new or changed URL must resolve to
 * public addresses only, as `ctx.http` requires again on every request. The
 * URL's form (`https://`, a host name, no credentials) is checked by the
 * settings validation; this adds the address check, which needs DNS. Values
 * left as they were are not looked up again, so a temporary DNS failure never
 * blocks saving another setting. Returns the problems found.
 */
export async function pluginSettingHostProblems(
  manifest: PluginManifest, settings: unknown, previous: PluginSettingValues, lookup: ExtensionLookup = defaultLookup,
): Promise<string[]> {
  if (!manifest.outboundHostsFromSettings.length) return [];
  const result = validatePluginSettings(manifest.settings, settings);
  // Malformed settings are refused by the validation itself, with its own messages.
  if (!result.ok) return [];
  const checks = manifest.outboundHostsFromSettings.map(async key => {
    const value = result.settings[key];
    const host = pluginHttpsUrlHost(value);
    if (!host || (Object.hasOwn(previous, key) && previous[key] === value)) return null;
    return hostProblem(key, host, lookup);
  });
  return (await Promise.all(checks)).filter((problem): problem is string => problem !== null);
}
