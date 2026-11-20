// Lint fixture: a plugin handler that imports ProPR internals. The
// restricted-imports rule for packages/plugins/** must reject every import
// below; packages/core/test/pluginHandlerLint.test.ts lints this file as if it
// were packages/plugins/fixture-imports-core/handlers.ts. Never executed.
import { PluginStore } from '@propr/core';
import { listRepositoryEvents } from '../../core/src/services/repositoryEventJournal.js';
import type { PluginContext } from '@propr/shared';

export async function leak(_input: unknown, ctx: PluginContext) {
  const api = await import('@propr/api');
  return { store: typeof PluginStore, events: typeof listRepositoryEvents, api: typeof api, plugin: ctx.pluginId };
}
