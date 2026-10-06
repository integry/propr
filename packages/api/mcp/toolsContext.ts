import { z } from 'zod';
import { loadMonitoredReposRaw, searchRepositoryFiles, readRepositoryFileContent, RepositoryRetrievalError, type ReadRepositoryFileResult, type RepositoryRetrievalErrorKind, type SearchRepositoryFilesResult } from '@propr/core';
import { type McpTool, type ToolDeps, repositorySchema, pageShape, ok } from './tools.js';
import { MAX_TOOL_RESULT_BYTES, McpError } from './config.js';
import { redactText } from './adapter.js';

const refShape = { branch: z.string().min(1).max(255).optional(), ref: z.string().min(1).max(255).optional() };

function assertRelativePath(path: string): void {
  if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\') || path.includes('\0')) throw new McpError('INVALID_PATH', 'Use a repository-relative path without traversal.');
}

/**
 * Resolves the configured spelling of an authorized repository (the policy
 * matches names case-insensitively) and its base branch when none was given,
 * so a differently cased name reuses the same clone, index and summaries.
 */
async function configuredTarget(repository: string, branch?: string): Promise<{ repository: string; branch: string | undefined }> {
  const configured = (await loadMonitoredReposRaw()).find(repo => repo.name.toLowerCase() === repository.toLowerCase());
  return { repository: configured?.name ?? repository, branch: branch || configured?.baseBranch || undefined };
}

const ERROR_CODES: Record<RepositoryRetrievalErrorKind, string> = {
  invalid_path: 'INVALID_PATH', invalid_ref: 'INVALID_REF', binary_file: 'BINARY_FILE', file_not_found: 'FILE_NOT_FOUND', ref_not_found: 'REF_NOT_FOUND',
};

/** Maps retrieval service failures onto stable MCP error codes by their kind and status. */
async function retrieval<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!(error instanceof RepositoryRetrievalError)) throw error;
    const message = error.message;
    if (error.status === 403) throw new McpError('REPOSITORY_FORBIDDEN', 'Current GitHub repository access denied.', 403);
    if (error.kind && (error.status === 400 || error.status === 404)) throw new McpError(ERROR_CODES[error.kind], message, error.status);
    if (error.status === 404) throw new McpError('FILE_NOT_FOUND', message, 404);
    if (error.status === 413) throw new McpError('FILE_TOO_LARGE', message, 413);
    if (error.status === 400) throw new McpError('INVALID_INPUT', message);
    // 500 is a local git or relevance-engine failure; retrying will not help.
    if (error.status === 500) throw new McpError('REPOSITORY_RETRIEVAL_FAILED', 'Repository retrieval failed.', 500);
    throw new McpError('REPOSITORY_RETRIEVAL_FAILED', 'Repository retrieval failed.', 502, { retryable: true });
  }
}

/** Largest `maxBytes` a read accepts; the JSON-encoded content is separately held under the response limit. */
const MAX_READ_BYTES = 200_000;
/** Response bytes reserved for everything except `content` or `matches` (paths, refs, pagination, freshness). */
const RESULT_ENVELOPE_RESERVE = 16 * 1024;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * Applies the executor's credential masking to the result's text fields other
 * than file content and line previews (which the fit helpers mask themselves)
 * before the response is measured, so masking that lengthens a string
 * (`ghp_a` becomes `[redacted]`) cannot push a fitted page over the limit.
 * Masking is idempotent, so the executor's pass leaves these unchanged.
 */
function maskReadEnvelope(result: ReadRepositoryFileResult): ReadRepositoryFileResult {
  return { ...result, repository: redactText(result.repository), path: redactText(result.path), ref: redactText(result.ref),
    ...(result.refCaveat !== undefined ? { refCaveat: redactText(result.refCaveat) } : {}) };
}

function maskSearchEnvelope(result: SearchRepositoryFilesResult): SearchRepositoryFilesResult {
  return {
    ...result,
    repository: redactText(result.repository),
    query: redactText(result.query),
    ref: redactText(result.ref),
    pathPrefix: result.pathPrefix === null ? null : redactText(result.pathPrefix),
    ...(result.keywordsDetected ? { keywordsDetected: result.keywordsDetected.map(redactText) } : {}),
    ...(result.refCaveat !== undefined ? { refCaveat: redactText(result.refCaveat) } : {}),
    ...(result.freshness ? { freshness: { ...result.freshness, ...(result.freshness.caveat !== undefined ? { caveat: redactText(result.freshness.caveat) } : {}) } } : {}),
  };
}

/**
 * Masks credentials in the returned lines (the executor treats them as opaque
 * text) and the other text fields, and keeps the result inside the response
 * limit. The service already bounded the encoded content, so this only drops
 * trailing lines when masking grew it, keeping endLine, returnedBytes and
 * nextStartLine true to `content`.
 */
export function fitReadResult(unmasked: ReadRepositoryFileResult): ReadRepositoryFileResult {
  const result = maskReadEnvelope(unmasked);
  const lines = result.content === '' ? [] : redactText(result.content).split('\n');
  const budget = MAX_TOOL_RESULT_BYTES - jsonBytes({ ...result, content: '', endLine: Number.MAX_SAFE_INTEGER, returnedBytes: Number.MAX_SAFE_INTEGER, nextStartLine: Number.MAX_SAFE_INTEGER, truncated: false });
  let used = 0, kept = 0;
  for (const line of lines) {
    const cost = jsonBytes(line) - 2 + (kept ? 2 : 0);
    if (used + cost > budget) break;
    used += cost;
    kept += 1;
  }
  if (kept === 0 && lines.length) throw new McpError('FILE_TOO_LARGE', `Line ${result.startLine} of "${result.path}" does not fit in the ${MAX_TOOL_RESULT_BYTES}-byte response once encoded, so it cannot be read at any maxBytes.`, 413);
  const content = lines.slice(0, kept).join('\n');
  if (kept === lines.length) return { ...result, content, returnedBytes: Buffer.byteLength(content) };
  const endLine = result.startLine + kept - 1;
  return { ...result, content, endLine, returnedBytes: Buffer.byteLength(content), truncated: true, nextStartLine: endLine + 1 };
}

/**
 * Masks credentials in paths, line previews and the other text fields, and
 * keeps a search page inside the response limit by ending the page early;
 * `nextOffset` then continues from the first match left out.
 */
export function fitSearchResult(unmasked: SearchRepositoryFilesResult): SearchRepositoryFilesResult {
  const result = maskSearchEnvelope(unmasked);
  const matches = result.matches.map(match => ({ ...match, path: redactText(match.path),
    ...(match.lineMatches ? { lineMatches: match.lineMatches.map(line => ({ ...line, text: redactText(line.text) })) } : {}) }));
  let used = jsonBytes({ ...result, matches: [], pagination: { ...result.pagination, nextOffset: Number.MAX_SAFE_INTEGER } });
  let kept = 0;
  for (const match of matches) {
    const cost = jsonBytes(match) + 1;
    if (used + cost > MAX_TOOL_RESULT_BYTES) break;
    used += cost;
    kept += 1;
  }
  if (kept === matches.length) return { ...result, matches };
  // A single match always fits (previews are capped); keeping one guarantees progress.
  kept = Math.max(kept, 1);
  return { ...result, matches: matches.slice(0, kept), pagination: { ...result.pagination, nextOffset: result.pagination.offset + kept } };
}

export function addContextTools(tools: McpTool[], { db, policy }: ToolDeps): void {
  tools.push({ name: 'resolve_reference', description: 'Find authorized repositories by name/alias, or plans, goals, tasks and TODOs within a repository by exact ID/name or fuzzy words. Returns candidates; never silently chooses a mutation target.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema.optional(), kind: z.enum(['repository', 'plan', 'goal', 'task', 'todo']), query: z.string().min(1).max(256), ...pageShape }).strict(), run: async ({ principal, args }) => {
      if (args.kind === 'repository') {
        const accessible = [];
        for (const repo of (await loadMonitoredReposRaw()).filter(repo => repo.enabled)) {
          try { await policy.repository(principal, repo.name); accessible.push({ id: repo.name, name: repo.alias || repo.name, baseBranch: repo.baseBranch }); }
          catch (error) { if (!(error instanceof McpError) || error.status !== 403) throw error; }
        }
        const query = args.query.trim().toLowerCase();
        const exact = accessible.filter(repo => repo.id.toLowerCase() === query || repo.name.toLowerCase() === query);
        const matches = exact.length ? exact : accessible.filter(repo => query.split(/\s+/).every((word: string) => `${repo.id} ${repo.name}`.toLowerCase().includes(word)));
        return ok({ match: exact.length === 1 ? 'exact' : matches.length > 1 ? 'ambiguous' : matches.length ? 'candidates' : 'not_found', candidates: matches.slice(args.offset, args.offset + args.limit), nextOffset: args.offset + args.limit < matches.length ? args.offset + args.limit : null });
      }
      if (!args.repository) throw new McpError('MISSING_INPUT', 'Choose an exact repository before resolving this reference.');
      const mapping = { plan: ['task_drafts', 'draft_id', 'name', 'user_id'], goal: ['goals', 'goal_id', 'title', 'owner_id'], task: ['tasks', 'task_id', 'task_id', null], todo: ['repo_todos', 'todo_id', 'content', 'user_id'] } as const;
      const [table, id, name, owner] = mapping[args.kind as keyof typeof mapping];
      const query = db(table).where({ repository: args.repository });
      if (owner) query.andWhere(owner, principal.user.id);
      if (table === 'tasks') {
        query.whereNotIn('task_id', db('goals').select('current_task_id').whereNot('owner_id', principal.user.id).whereNotNull('current_task_id'));
        query.andWhere(builder => builder.whereNot('task_type', 'goal').orWhereIn('task_id', db('goals').select('current_task_id').where({ owner_id: principal.user.id }))); 
      }
      const exact = await query.clone().andWhere(builder => builder.where(id, args.query).orWhereRaw('lower(??) = lower(?)', [name, args.query])).select({ id, name }).limit(100);
      if (exact.length) return ok({ match: exact.length === 1 ? 'exact' : 'ambiguous', candidates: exact });
      const words = args.query.trim().split(/\s+/).slice(0, 8);
      for (const word of words) query.andWhereRaw("lower(??) LIKE lower(?) ESCAPE '\\'", [name, `%${word.replace(/[\\%_]/g, '\\$&')}%`]);
      const candidates = await query.select({ id, name }).orderBy(id).offset(args.offset).limit(args.limit);
      return ok({ match: candidates.length ? 'candidates' : 'not_found', candidates, nextOffset: candidates.length === args.limit ? args.offset + args.limit : null });
    } });
  tools.push({ name: 'get_repository_context', description: 'Read indexed overview, tree, path summary or text search with indexing freshness. Paths are repository-relative.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, branch: z.string().min(1).max(255).optional(), mode: z.enum(['overview', 'tree', 'path', 'search']).default('overview'), path: z.string().max(1024).default(''), query: z.string().max(200).optional(), ...pageShape }).strict(), run: async ({ args }) => {
      if (args.path.startsWith('/') || args.path.split('/').includes('..') || args.path.includes('\\')) throw new McpError('INVALID_PATH', 'Use a repository-relative path without traversal.');
      args.branch ||= (await loadMonitoredReposRaw()).find(repo => repo.name === args.repository)?.baseBranch || 'HEAD';
      const repository = await db('repositories').where({ full_name: args.repository, branch: args.branch }).first();
      if (!repository) throw new McpError('CONTEXT_NOT_INDEXED', 'This repository branch has not been indexed.', 404);
      const prefix = `${args.repository}/${args.path}`.replace(/\/$/, '');
      const build = (table: string) => {
        const query = db(table).where({ branch: args.branch });
        if (args.mode === 'overview') query.andWhere('path', args.repository);
        else if (args.mode === 'path') query.andWhere('path', prefix);
        else {
          query.andWhereRaw("path LIKE ? ESCAPE '\\'", [`${prefix.replace(/[\\%_]/g, '\\$&')}/%`]);
          if (args.mode === 'tree') query.whereRaw("path NOT LIKE ? ESCAPE '\\'", [`${prefix.replace(/[\\%_]/g, '\\$&')}/%/%`]);
          if (args.mode === 'search') {
            if (!args.query) throw new McpError('MISSING_INPUT', 'A search query is required.');
            query.andWhereRaw("summary LIKE ? ESCAPE '\\'", [`%${args.query.replace(/[\\%_]/g, '\\$&')}%`]);
          }
        }
        return query.select('path', 'summary').orderBy('path').offset(args.offset).limit(args.limit);
      };
      const directories = await build('directory_summaries'), files = args.mode === 'overview' ? [] : await build('file_summaries');
      return ok({ repository: args.repository, branch: args.branch, freshness: { state: repository.indexing_status, indexedAt: repository.last_indexed_at, revision: repository.last_indexed_hash }, directories, files, nextOffset: Math.max(directories.length, files.length) === args.limit ? args.offset + args.limit : null });
    } });
  tools.push({ name: 'search_repository_files', description: 'Search repository files and return matching paths (no full file contents). mode "semantic" (default) ranks files with the index-based planner relevance engine (file summaries, path and git-history signals) and reports index freshness; mode "literal" runs an exact, non-regex string grep across the git tree at the requested ref and returns per-file match counts with the first matching lines (scanTruncated means the grep hit its output budget, so totalMatches is a lower bound and a file flagged countTruncated has a matchCount that is only a lower bound; narrow the query or path). Optionally restrict to a repository-relative path prefix. Follow up with read_repository_file to read a match.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, query: z.string().min(1).max(1000), mode: z.enum(['semantic', 'literal']).default('semantic'), ...refShape, path: z.string().max(1024).optional(), caseSensitive: z.boolean().optional(), ...pageShape }).strict(), run: async ({ principal, args }) => {
      // The executor has already authorized args.repository for this call.
      if (args.path) assertRelativePath(args.path);
      const { repository, branch } = await configuredTarget(args.repository, args.branch);
      return ok(fitSearchResult(await retrieval(() => searchRepositoryFiles({ repository, branch, ref: args.ref, query: args.query, mode: args.mode, path: args.path || undefined,
        caseSensitive: args.caseSensitive, offset: args.offset, limit: args.limit, authToken: principal.user.accessToken || undefined }))));
    } });
  tools.push({ name: 'read_repository_file', description: 'Read a text file at a branch, ref or commit straight from git, in bounded line chunks, without cloning locally. Returns content with startLine, endLine, totalLines and a truncated flag; when truncated (by maxLines, maxBytes or the response size limit), continue from nextStartLine. Paths are repository-relative; binary files are rejected.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, path: z.string().min(1).max(1024), ...refShape, startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).optional(),
      maxLines: z.number().int().min(1).max(1000).default(800), maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(120000) }).strict(), run: async ({ principal, args }) => {
      // The executor has already authorized args.repository for this call.
      assertRelativePath(args.path);
      if (args.endLine !== undefined && args.endLine < args.startLine) throw new McpError('INVALID_INPUT', 'endLine must be greater than or equal to startLine.');
      const { repository, branch } = await configuredTarget(args.repository, args.branch);
      return ok(fitReadResult(await retrieval(() => readRepositoryFileContent({ repository, branch, ref: args.ref, path: args.path, startLine: args.startLine, endLine: args.endLine,
        maxLines: args.maxLines, maxBytes: args.maxBytes, maxBytesLimit: MAX_READ_BYTES, encodedByteLimit: MAX_TOOL_RESULT_BYTES - RESULT_ENVELOPE_RESERVE, authToken: principal.user.accessToken || undefined }))));
    } });
}
