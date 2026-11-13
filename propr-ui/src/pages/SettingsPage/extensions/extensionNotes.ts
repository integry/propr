import { createElement } from 'react';
import type { ExtensionLibraryServer, ExtensionLibrarySkill, ExtensionLibraryUsage, ExtensionSecretStatus } from '@propr/shared';
import type { ExtensionItemNote } from './ExtensionItemRow';
import { CodexLimitation } from './CodexLimitation';
import { appliesToCodex, ownEntry, type ExtensionChoices } from './extensionUi';

const quoted = (names: string[]) => names.map(name => `“${name}”`).join(', ');

/** A server whose administrator-entered credential is missing, which runs skip. */
function missingCredentialNote(server: ExtensionLibraryServer, secrets?: Record<string, ExtensionSecretStatus>): ExtensionItemNote | null {
  if (ownEntry(secrets, server.name)?.configured) return null;
  if (server.kind === 'https' && server.authentication === 'bearer') return { tone: 'warning', text: 'Bearer token not configured: runs skip this server until a token is saved.' };
  if (server.kind === 'package' && server.secretEnv.length) return { tone: 'warning', text: 'Secret variables not configured: runs skip this server until every value is saved.' };
  return null;
}

/** Warnings and usage notes shown on one library item. */
export function itemNotes(item: ExtensionLibraryServer | ExtensionLibrarySkill, context: {
  usage: ExtensionLibraryUsage;
  choices: ExtensionChoices;
  secrets?: Record<string, ExtensionSecretStatus>;
}): ExtensionItemNote[] {
  const notes: ExtensionItemNote[] = [];
  const server = 'kind' in item ? item : undefined;
  const importedFrom = server ? ownEntry(context.usage.importedFrom.servers, server.name) : ownEntry(context.usage.importedFrom.skills, (item as ExtensionLibrarySkill).bundleId);
  const automations = context.usage.automations
    .filter(automation => (server ? automation.servers.includes(server.name) : automation.skills.includes((item as ExtensionLibrarySkill).bundleId)))
    .map(automation => automation.name);
  if (importedFrom?.length && !item.autoApply) {
    notes.push({ tone: 'info', text: `Imported from ${importedFrom.length > 1 ? 'profiles' : 'profile'} ${quoted(importedFrom)}; not applied automatically.` });
  }
  if (automations.length) {
    notes.push(item.enabled
      ? { tone: 'info', text: `Added by ${automations.length > 1 ? 'automations' : 'automation'} ${quoted(automations)}.` }
      : { tone: 'warning', text: `Added by ${automations.length > 1 ? 'automations' : 'automation'} ${quoted(automations)}, which currently ${automations.length > 1 ? 'run' : 'runs'} without it.` });
  }
  const missing = server ? missingCredentialNote(server, context.secrets) : null;
  if (missing) notes.push(missing);
  if (item.enabled && appliesToCodex(item, context.choices.codexAgents)) notes.push({ tone: 'warning', text: createElement(CodexLimitation) });
  return notes;
}
