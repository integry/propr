import { extensionPackageSecretKey, type ExtensionLibraryPackageServer, type ExtensionLibraryServer, type ExtensionSecretStatus } from '@propr/shared';

/** Servers authenticated by a Bearer token the administrator entered. */
export const bearerServers = (servers: ExtensionLibraryServer[]) => servers.filter(s => s.kind === 'https' && s.authentication === 'bearer');
/** Servers with an administrator-entered credential: a Bearer token, or the client secret of a pre-registered OAuth client. */
export const credentialServers = (servers: ExtensionLibraryServer[]) => servers.filter(s => s.kind === 'https' && (s.authentication === 'bearer' || (s.authentication === 'oauth' && s.clientId !== undefined)));
export const credentialField = (server: ExtensionLibraryServer): ['bearerToken'] | ['clientSecret'] => (server.kind === 'https' && server.authentication === 'oauth' ? ['clientSecret'] : ['bearerToken']);
/** Package servers with write-only secret variables. */
export const packageSecretServers = (servers: ExtensionLibraryServer[]) => servers.filter((s): s is ExtensionLibraryPackageServer => s.kind === 'package' && s.secretEnv.length > 0);
/** The identity a stored credential belongs to: changing it never transfers the credential. */
export const credentialBinding = (server: ExtensionLibraryServer) => (server.kind === 'https'
  ? [server.name, server.url, server.authentication, server.clientId ?? null]
  : server.kind === 'package' ? [server.name, 'package', server.ecosystem, server.package] : [server.name]);
/** Credential bindings of a library: a revision that carries sealed credentials over must keep them. */
export const credentialBindings = (servers: ExtensionLibraryServer[]) => [
  ...credentialServers(servers).map(credentialBinding),
  ...packageSecretServers(servers).map(s => [...credentialBinding(s), [...s.secretEnv].sort()]),
];
/** Sealed-credential keys of one package server's secret variables. */
export const packageSecretKeys = (server: ExtensionLibraryPackageServer) => server.secretEnv.map(name => extensionPackageSecretKey(server.name, name));
/** Whether a secret replacement key names a credential of these servers. */
export const isCredentialKey = (servers: ExtensionLibraryServer[], key: string) => credentialServers(servers).some(s => s.name === key)
  || packageSecretServers(servers).some(s => packageSecretKeys(s).includes(key));
/** The server a sealed-credential key belongs to. */
export const credentialOwner = (key: string) => key.split('/')[0];
/** Configured state of a package server's secret variables; names only, never values. */
export function packageSecretStatus(server: ExtensionLibraryPackageServer, secrets: Record<string, string>): ExtensionSecretStatus {
  const configuredEnv = server.secretEnv.filter(name => Boolean(secrets[extensionPackageSecretKey(server.name, name)]));
  return { count: server.secretEnv.length, configured: configuredEnv.length === server.secretEnv.length, configuredEnv };
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Sealed-credential keys of a server: its own name for HTTPS credentials, `server/VARIABLE` for package secret variables. */
const credentialKeys = (server: ExtensionLibraryServer) => (server.kind === 'package' ? packageSecretKeys(server) : [server.name]);
/**
 * Credentials a save stores: a replacement when one is given, otherwise the
 * stored value while the server's credential binding (name, endpoint,
 * authentication, client, or package) is unchanged. Changing the binding
 * never transfers a credential silently.
 */
export function nextCredentials(servers: ExtensionLibraryServer[], previous: ExtensionLibraryServer[], stored: Record<string, string>, replacements: Record<string, string | null>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const server of [...credentialServers(servers), ...packageSecretServers(servers)]) {
    const kept = previous.some(s => s.name === server.name && sameJson(credentialBinding(s), credentialBinding(server)));
    for (const key of credentialKeys(server)) {
      const token = Object.hasOwn(replacements, key) ? replacements[key] : kept ? stored[key] : undefined;
      if (token) next[key] = token;
    }
  }
  return next;
}
type CatalogSecretStatus = { count: number; configured: boolean };
/**
 * Secret statuses of a new revision's servers. With `secrets` null (a change
 * that alters no credential) the base revision's statuses carry over.
 */
export function revisionSecretStatuses(servers: ExtensionLibraryServer[], previous: { servers: ExtensionLibraryServer[]; secrets: Record<string, ExtensionSecretStatus> }, secrets: Record<string, string> | null, catalogSecrets: Map<string, CatalogSecretStatus>): Record<string, ExtensionSecretStatus> {
  const statuses: Record<string, ExtensionSecretStatus> = {};
  const carried = (name: string) => (Object.hasOwn(previous.secrets, name) ? previous.secrets[name] : undefined);
  for (const server of servers) {
    if (server.kind === 'https') {
      if (credentialServers([server]).length) statuses[server.name] = secrets ? { fields: credentialField(server), configured: Boolean(secrets[server.name]) } : carried(server.name) ?? { fields: credentialField(server), configured: false };
    } else if (server.kind === 'package') {
      if (server.secretEnv.length) statuses[server.name] = secrets ? packageSecretStatus(server, secrets) : carried(server.name) ?? packageSecretStatus(server, {});
    } else {
      const same = previous.servers.find(s => s.kind === 'catalog' && s.name === server.name && s.catalogId === server.catalogId && s.digest === server.digest);
      statuses[server.name] = catalogSecrets.get(server.name) ?? (same ? carried(server.name) : undefined) ?? { count: 0, configured: false };
    }
  }
  return statuses;
}
/** Secret variable values of package servers, by server and variable name. */
export const packageSecretValues = (servers: ExtensionLibraryPackageServer[], secrets: Record<string, string>) => Object.fromEntries(servers.map(server => [server.name, Object.fromEntries(server.secretEnv.map(name => [name, secrets[extensionPackageSecretKey(server.name, name)] ?? '']))]));
