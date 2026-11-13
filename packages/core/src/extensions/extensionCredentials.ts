import type { ExtensionLibraryServer } from '@propr/shared';

/** Servers authenticated by a Bearer token the administrator entered. */
export const bearerServers = (servers: ExtensionLibraryServer[]) => servers.filter(s => s.kind === 'https' && s.authentication === 'bearer');
/** Servers with an administrator-entered credential: a Bearer token, or the client secret of a pre-registered OAuth client. */
export const credentialServers = (servers: ExtensionLibraryServer[]) => servers.filter(s => s.kind === 'https' && (s.authentication === 'bearer' || (s.authentication === 'oauth' && s.clientId !== undefined)));
export const credentialField = (server: ExtensionLibraryServer): ['bearerToken'] | ['clientSecret'] => (server.kind === 'https' && server.authentication === 'oauth' ? ['clientSecret'] : ['bearerToken']);
/** The identity a stored credential belongs to: changing it never transfers the credential. */
export const credentialBinding = (server: ExtensionLibraryServer) => (server.kind === 'https' ? [server.name, server.url, server.authentication, server.clientId ?? null] : [server.name]);
/** Credential bindings of a library: a revision that carries sealed credentials over must keep them. */
export const credentialBindings = (servers: ExtensionLibraryServer[]) => credentialServers(servers).map(credentialBinding);
