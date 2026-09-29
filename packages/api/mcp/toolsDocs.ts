import { z } from 'zod';
import { McpError } from './config.js';
import {
  DocsIndexError, getIndexedDoc, listIndexedDocs, loadDocsIndex, searchIndexedDocs,
} from './docsIndex.js';
import { ok, type McpTool, type ToolDeps } from './tools.js';

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
    name: 'list_docs',
    description: 'List bundled ProPR documentation pages and stable paths. Filter by the first path segment, such as features, operations or mcp.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      section: z.string().trim().min(1).max(100).optional(),
      offset: z.number().int().min(0).max(100000).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    run: async ({ args }) => ok(await docsResult(async () => listIndexedDocs(await loadDocsIndex(), {
      section: args.section, offset: args.offset, limit: args.limit,
    }))),
  });

  tools.push({
    name: 'get_doc',
    description: 'Read a bounded chunk of a bundled ProPR documentation page. Use path values from list_docs or search_docs; section is an exact heading match.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      path: z.string().min(1).max(512),
      offset: z.number().int().min(0).max(10_000_000).default(0),
      maxChars: z.number().int().min(1000).max(16000).default(8000),
      section: z.string().trim().min(1).max(500).optional(),
    }).strict(),
    run: async ({ args }) => ok(await docsResult(async () => getIndexedDoc(await loadDocsIndex(), args.path, {
      offset: args.offset, maxChars: args.maxChars, section: args.section,
    }))),
  });

  tools.push({
    name: 'search_docs',
    description: 'Search bundled ProPR documentation by title, heading and body terms. Pass a result heading to get_doc.section for focused reading.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      query: z.string().trim().min(2).max(200),
      limit: z.number().int().min(1).max(20).default(10),
    }).strict(),
    run: async ({ args }) => ok(await docsResult(async () => searchIndexedDocs(await loadDocsIndex(), args.query, args.limit))),
  });
}
