import {
  EXACT_VERSION_PATTERN, extensionPackageEnvConflict, extensionPackageEnvNameSchema, extensionPackageNameSchema, extensionPackageSecretKey,
  type ExtensionLibraryServer, type ExtensionSecretAcknowledgement,
} from '@propr/shared';

export const PACKAGE_TYPE = '__package';
export const isExactVersion = (version: string) => EXACT_VERSION_PATTERN.test(version);
/** The acknowledgement still covers this package, version and set of secret variables. */
export const acknowledgementCovers = (acknowledgement: ExtensionSecretAcknowledgement | undefined, server: ExtensionLibraryServer | undefined) => Boolean(acknowledgement
  && server?.kind === 'package' && acknowledgement.package === server.package && acknowledgement.version === server.version
  && [...acknowledgement.secretEnv].sort().join('\n') === [...server.secretEnv].sort().join('\n'));

/**
 * What an acknowledgement given in the form is for: the server name, package, version and set of secret variables.
 * Changing any of them makes a tick given earlier, or one carried from the saved revision, no longer apply.
 */
export const acknowledgementScope = (server: ExtensionLibraryServer) => (server.kind === 'package'
  ? JSON.stringify([server.name, server.ecosystem, server.package, server.version, [...server.secretEnv].sort()]) : '');

/** The value of the form's server type select. */
export const serverTypeValue = (draft: ExtensionLibraryServer) => (draft.kind === 'catalog' ? draft.catalogId : draft.kind === 'package' ? PACKAGE_TYPE : '');
/** The servers a save acknowledges: this package server when it has secret variables and the box is ticked. */
export const acknowledgedNames = (draft: ExtensionLibraryServer, acknowledged: boolean) => (draft.kind === 'package' && draft.secretEnv.length && acknowledged ? [draft.name] : []);

/** How a row names the server's kind: HTTPS, local package with its pinned version, or operator catalog. */
export const serverKindLabel = (server: ExtensionLibraryServer) => (server.kind === 'https' ? (server.authentication === 'oauth' ? 'HTTPS endpoint · OAuth' : 'HTTPS endpoint')
  : server.kind === 'package' ? `Local · ${server.package}@${server.version}` : `Operator catalog: ${server.catalogId}`);

/** Why a local package server cannot be saved yet, or null. */
export function packageProblem(draft: ExtensionLibraryServer, acknowledged: boolean): string | null {
  if (draft.kind !== 'package') return null;
  if (!extensionPackageNameSchema.safeParse(draft.package).success) return 'Enter an npm package name.';
  if (!isExactVersion(draft.version)) return 'Enter an exact version such as 1.2.3. Ranges and tags (latest, ^1.2) are not accepted.';
  const invalid = [...draft.env.map(variable => variable.name), ...draft.secretEnv].find(name => !extensionPackageEnvNameSchema.safeParse(name).success);
  if (invalid !== undefined) return `${invalid || 'An empty name'} cannot be used as a variable name: use uppercase letters, digits and _, not a reserved name such as PATH or NODE_OPTIONS.`;
  const duplicate = extensionPackageEnvConflict(draft);
  if (duplicate) return `Variable ${duplicate} is listed more than once.`;
  if (draft.secretEnv.length && !acknowledged) return 'Confirm that the secret values are readable inside the task container before saving.';
  return null;
}

/** Bearer servers send their token; OAuth servers with a pre-registered client send its secret. */
const carriesSecret = (draft: ExtensionLibraryServer) => draft.kind === 'https' && (draft.authentication === 'bearer' || (draft.authentication === 'oauth' && draft.clientId !== undefined));
/** Write-only values a save sends: an HTTPS token under the server name, package secrets under server/VARIABLE. */
export function writeOnlyValues(draft: ExtensionLibraryServer, token: string, secretValues: Record<string, string>): Record<string, string> {
  if (draft.kind === 'package') return Object.fromEntries(draft.secretEnv.flatMap(name => (secretValues[name] ? [[extensionPackageSecretKey(draft.name, name), secretValues[name]]] : [])));
  return carriesSecret(draft) && token ? { [draft.name]: token } : {};
}
