import { z } from 'zod';
import packageInfo from '../package.json' with { type: 'json' };
import { McpError } from './config.js';
import {
  DocsIndexError, getIndexedDoc, listIndexedDocs, loadDocsIndex, searchIndexedDocs,
} from './docsIndex.js';
import { SETTINGS_CATALOG, type SettingEntry } from './settingsCatalog.js';
import { ok, type McpTool, type ToolDeps } from './tools.js';

const normalizeSettingQuery = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function settingScore(entry: SettingEntry, query: string): number {
  const terms = normalizeSettingQuery(query).split(' ').filter(Boolean);
  const fields = [entry.label, ...entry.aliases, entry.id, ...(entry.env ?? [])];
  let best = 0;
  for (const [index, field] of fields.entries()) {
    const normalized = normalizeSettingQuery(field);
    const priority = index === 0 ? 40 : index <= entry.aliases.length ? 30 : index === entry.aliases.length + 1 ? 20 : 10;
    if (normalized === normalizeSettingQuery(query)) best = Math.max(best, 400 + priority);
    else if (normalized.startsWith(normalizeSettingQuery(query))) best = Math.max(best, 300 + priority);
    else if (normalized.includes(normalizeSettingQuery(query))) best = Math.max(best, 200 + priority);
    else if (terms.every(term => normalized.includes(term))) best = Math.max(best, 100 + priority);
  }
  const haystack = normalizeSettingQuery(fields.join(' '));
  return best || (terms.every(term => haystack.includes(term)) ? 50 : 0);
}

function environmentChangeInstruction(entry: SettingEntry, query: string): string {
  const variables = entry.env ?? [];
  const exactMatch = variables.find(variable => normalizeSettingQuery(variable) === normalizeSettingQuery(query));
  const restart = entry.restartRequired ? ' and restart ProPR' : '';
  if (exactMatch || variables.length <= 1) {
    return `Change ${exactMatch ?? variables[0] ?? 'this value'} in the deployment environment${restart}`;
  }
  const restartGroup = entry.restartRequired ? '; then restart ProPR' : '';
  return `Configure the applicable deployment environment variables separately: ${variables.join(', ')}${restartGroup}`;
}

function howToChange(
  entry: SettingEntry,
  query: string,
  tools: McpTool[],
  access: { permissions: readonly string[]; scopes: readonly string[] },
): string {
  const referencedTools = [entry.mcp?.read, entry.mcp?.write]
    .flatMap(name => name ? tools.filter(tool => tool.name === name) : []);
  const missingPermissions = [...new Set(referencedTools
    .map(tool => tool.permission).filter(permission => permission && !access.permissions.includes(permission)))];
  const missingScopes = [...new Set(referencedTools
    .map(tool => tool.scope).filter(scope => !access.scopes.includes(scope)))];
  const requirements = [
    missingPermissions.length && `requires ${missingPermissions.join(' and ')}`,
    missingScopes.length && `requires the ${missingScopes.join(' and ')} scope`,
  ].filter(Boolean).join(' and ');
  const requirement = requirements ? `; MCP access ${requirements}` : '';
  if (entry.mcpStatus === 'browser_only') {
    const location = entry.ui ? ` in ${entry.ui}` : '';
    return `Change it${location}; MCP editing is unavailable — ${(entry.reason ?? 'Browser setup is required.').replace(/\.$/, '')}.`;
  }
  if (entry.mcpStatus === 'environment_only') {
    return `${environmentChangeInstruction(entry, query)}${requirement}.`;
  }
  if (entry.mcpStatus === 'read_only') {
    return `${environmentChangeInstruction(entry, query)}; MCP can only read it${entry.mcp?.read ? ` with ${entry.mcp.read}` : ''}${requirement}.`;
  }
  const locations = [entry.mcp?.write && `with ${entry.mcp.write}`, entry.ui && `in ${entry.ui}`, entry.cli && `with \`${entry.cli}\``].filter(Boolean);
  return `Change it ${locations.join(', or ')}${requirement}.`;
}

function publicDocsError(error: unknown): never {
  if (!(error instanceof DocsIndexError)) throw error;
  const unavailable = error.code === 'DOCS_UNAVAILABLE';
  throw new McpError(error.code, error.message, unavailable ? 503 : 404, {
    stage: unavailable ? 'internal' : 'validation',
    retryable: false,
  });
}

async function docsResult<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    return publicDocsError(error);
  }
}

/** Register repository-independent, read-only access to the bundled ProPR docs. */
export function addDocsTools(tools: McpTool[], deps: ToolDeps): void {
  void deps; // Kept in the registrar contract so future docs metadata can use instance dependencies without rewiring the catalog.
  tools.push({
    name: 'find_setting',
    description: 'Find where a ProPR setting lives and how it can be changed, including browser-only and environment-only settings.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      query: z.string().trim().min(2).max(100),
      limit: z.number().int().min(1).max(10).default(10),
    }).strict(),
    run: async ({ principal, args }) => {
      const matches = SETTINGS_CATALOG
        .map((entry, order) => ({ entry, order, score: settingScore(entry, args.query) }))
        .filter(match => match.score > 0)
        .sort((left, right) => right.score - left.score || left.order - right.order)
        .slice(0, args.limit)
        .map(({ entry }) => ({
          ...entry,
          howToChange: howToChange(entry, args.query, tools, {
            permissions: principal.authorization.permissions,
            scopes: principal.scopes,
          }),
        }));
      return ok({ query: args.query, matches });
    },
  });

  tools.push({
    name: 'list_docs',
    description: 'List bundled ProPR documentation pages and stable paths. Filter by the first path segment, such as features, operations or mcp.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      section: z.string().trim().min(1).max(100).optional(),
      offset: z.number().int().min(0).max(100000).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    run: async ({ args }) => ok(await docsResult(async () => {
      const index = await loadDocsIndex();
      const result = listIndexedDocs(index, {
        section: args.section, offset: args.offset, limit: args.limit,
      });
      if (index.docsVersion === packageInfo.version) return result;
      return {
        ...result,
        versionMismatch: { docs: index.docsVersion, api: packageInfo.version },
        warning: 'Bundled documentation version does not match the running API version. PROPR_DOCS_DIR may contain stale docs.',
      };
    })),
  });

  tools.push({
    name: 'get_doc',
    description: 'Read a bounded chunk of a bundled ProPR documentation page. Use path values from list_docs or search_docs; section accepts an exact heading or a locator returned by search_docs.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      path: z.string().min(1).max(512),
      offset: z.number().int().min(0).max(10_000_000).default(0),
      maxChars: z.number().int().min(1000).max(16000).default(8000),
      section: z.union([
        z.string().trim().min(1).max(500),
        z.object({
          heading: z.string().min(1).max(500),
          offset: z.number().int().min(0).max(10_000_000),
        }).strict(),
      ]).optional(),
    }).strict(),
    run: async ({ args }) => ok(await docsResult(async () => getIndexedDoc(await loadDocsIndex(), args.path, {
      offset: args.offset, maxChars: args.maxChars, section: args.section,
    }))),
  });

  tools.push({
    name: 'search_docs',
    description: 'Search bundled ProPR documentation by title, heading and body terms. Pass a non-null result section to get_doc.section for focused reading; when section is null, read the result path without a section.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      query: z.string().trim().min(2).max(200),
      limit: z.number().int().min(1).max(20).default(10),
    }).strict(),
    run: async ({ args }) => ok(await docsResult(async () => searchIndexedDocs(await loadDocsIndex(), args.query, args.limit))),
  });
}
