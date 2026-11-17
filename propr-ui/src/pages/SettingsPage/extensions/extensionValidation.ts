import { useState } from 'react';
import { extensionPackageNameSchema, extensionRepositorySchema, extensionServerNameSchema, type ExtensionLibraryServer } from '@propr/shared';
import { isExactVersion } from './packageServerUi';

/**
 * Client-side checks of the server form. They mirror the API's rules
 * (`extensionServerNameSchema` and Core's `extensionEndpoint`) so the form can
 * say what is wrong before saving; the API stays the authority.
 */

export const SERVER_NAME_MAX = 48;
const ENDPOINT_MAX = 2048;

/** Why a server name cannot be saved, or null. */
export function serverNameProblem(name: string, others: readonly { name: string }[] = []): string | null {
  if (!name) return 'Enter a name.';
  if (name.length > SERVER_NAME_MAX) return `Use at most ${SERVER_NAME_MAX} characters.`;
  if (!/^[a-z]/.test(name)) return 'Start with a lowercase letter.';
  if (!/^[a-z0-9_-]+$/.test(name)) return 'Use only lowercase letters, digits, - and _.';
  if (!extensionServerNameSchema.safeParse(name).success) return `${name} is reserved.`;
  if (others.some(server => server.name === name)) return `Another server is already named ${name}.`;
  return null;
}

/** Why an MCP endpoint cannot be saved, or null: HTTPS on port 443 without credentials, query or fragment. */
export function endpointProblem(value: string): string | null {
  if (!value) return 'Enter the endpoint URL.';
  if (!/^https:\/\//i.test(value)) return 'Use an https:// address.';
  if (!value.startsWith('https://')) return 'Write https:// in lowercase.';
  if (value.length > ENDPOINT_MAX) return `Use at most ${ENDPOINT_MAX} characters.`;
  let url: URL;
  try { url = new URL(value); } catch { return 'Enter a valid URL.'; }
  if (!url.hostname) return 'Enter a valid URL.';
  if (url.username || url.password) return 'Remove the user name or password from the address.';
  if (/[?#]/.test(value)) return 'Remove the query string or fragment.';
  if (url.port && url.port !== '443') return 'Use port 443 or leave the port out.';
  if (/^(localhost|.*\.localhost|.*\.local|metadata\.google\.internal)$/i.test(url.hostname.replace(/^\[|\]$/g, ''))) return 'Use a public address.';
  return null;
}

export const isRepositoryName = (value: string) => extensionRepositorySchema.safeParse(value).success;
export const isFullCommit = (value: string) => /^[0-9a-f]{40}$/.test(value);

export type ServerField = 'name' | 'url' | 'package' | 'version';
export type ServerFieldProblems = Partial<Record<ServerField, string>>;

/** The field problems of a server draft; `others` are the library's other servers. */
export function serverFieldProblems(draft: ExtensionLibraryServer, others: readonly { name: string }[]): ServerFieldProblems {
  const problems: ServerFieldProblems = {};
  const name = serverNameProblem(draft.name, others);
  if (name) problems.name = name;
  if (draft.kind === 'https') {
    const url = endpointProblem(draft.url);
    if (url) problems.url = url;
  }
  if (draft.kind === 'package') {
    if (!draft.package) problems.package = 'Enter the npm package name.';
    else if (!extensionPackageNameSchema.safeParse(draft.package).success) problems.package = 'Enter a valid npm package name, such as @scope/name.';
    if (!draft.version) problems.version = 'Enter an exact version.';
    else if (!isExactVersion(draft.version)) problems.version = 'Enter an exact version such as 1.2.3. Ranges and tags (latest, ^1.2) are not accepted.';
  }
  return problems;
}

/**
 * The field problems of a server draft and the fields the user has left (or
 * tried to submit), whose problems are shown inline.
 */
export function useServerFieldChecks(draft: ExtensionLibraryServer, others: readonly { name: string }[]) {
  const [touched, setTouched] = useState<ReadonlySet<ServerField>>(() => new Set());
  const problems = serverFieldProblems(draft, others);
  return {
    problems,
    invalid: Object.keys(problems).length > 0,
    shownProblem: (field: ServerField) => (touched.has(field) ? problems[field] : undefined),
    touch: (field: ServerField) => setTouched(value => (value.has(field) ? value : new Set([...value, field]))),
    touchAll: () => setTouched(new Set(Object.keys(problems) as ServerField[])),
  };
}

/** Whether the server form holds typed content: a changed draft (against its JSON when opened), a token or a secret value. */
export const serverDraftDirty = (draft: ExtensionLibraryServer, opened: string, token: string, secretValues: Record<string, string>) =>
  JSON.stringify(draft) !== opened || token !== '' || Object.values(secretValues).some(Boolean);

/** The lookup of one typed or resolved commit. */
/**
 * `failed` means the repository answered with another commit; `unavailable` means the check itself
 * did not succeed, which can be temporary, so it may be retried.
 */
export interface CommitLookup { commit: string; status: 'checking' | 'verified' | 'failed' | 'unavailable' }

/**
 * The label of the commit a GitHub skill import will use. Nothing is called
 * confirmed until it is a full 40-character commit that a lookup verified.
 */
export function importCommitLabel(commit: string, lookup: CommitLookup | undefined): { tone: 'confirmed' | 'pending' | 'invalid'; text: string } | null {
  if (!commit) return null;
  if (!isFullCommit(commit)) return { tone: 'invalid', text: 'Enter the full 40-character commit (0–9, a–f).' };
  const status = lookup?.commit === commit ? lookup.status : 'checking';
  if (status === 'verified') return { tone: 'confirmed', text: 'Confirmed import commit:' };
  if (status === 'failed') return { tone: 'invalid', text: 'This commit was not found in the repository.' };
  if (status === 'unavailable') return { tone: 'invalid', text: 'This commit could not be verified. It may not exist in the repository, or the check failed.' };
  return { tone: 'pending', text: 'Checking the commit…' };
}
