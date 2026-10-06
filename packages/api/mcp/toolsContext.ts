import { z } from 'zod';
import { loadMonitoredReposRaw, searchRepositoryFiles, readRepositoryFileContent, RepositoryRetrievalError } from '@propr/core';
import { type McpTool, type ToolDeps, repositorySchema, pageShape, ok } from './tools.js';
import { McpError } from './config.js';

const refShape = { branch: z.string().min(1).max(255).optional(), ref: z.string().min(1).max(255).optional() };

function assertRelativePath(path: string): void {
  if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\') || path.includes('\0')) throw new McpError('INVALID_PATH', 'Use a repository-relative path without traversal.');
}

async function defaultBranch(repository: string, branch?: string): Promise<string | undefined> {
  return branch || (await loadMonitoredReposRaw()).find(repo => repo.name.toLowerCase() === repository.toLowerCase())?.baseBranch || undefined;
}

/** Maps retrieval service failures onto stable MCP error codes. */
async function retrieval<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!(error instanceof RepositoryRetrievalError)) throw error;
    const message = error.message;
    if (error.status === 403) throw new McpError('REPOSITORY_FORBIDDEN', 'Current GitHub repository access denied.', 403);
    if (error.status === 404) throw /^Ref /.test(message) ? new McpError('REF_NOT_FOUND', message, 404) : new McpError('FILE_NOT_FOUND', message, 404);
    if (error.status === 413) throw new McpError('FILE_TOO_LARGE', message, 413);
    if (error.status === 400) {
      if (/binary file/i.test(message)) throw new McpError('BINARY_FILE', message);
      if (/^Invalid ref/.test(message)) throw new McpError('INVALID_REF', message);
      if (/^(path|")/.test(message)) throw new McpError('INVALID_PATH', message);
      throw new McpError('INVALID_INPUT', message);
    }
    throw new McpError('REPOSITORY_RETRIEVAL_FAILED', 'Repository retrieval failed.', 502, { retryable: true });
  }
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
  tools.push({ name: 'search_repository_files', description: 'Search repository files and return matching paths (no full file contents). mode "semantic" (default) ranks files with the index-based planner relevance engine (file summaries, path and git-history signals) and reports index freshness; mode "literal" runs an exact, non-regex string grep across the git tree at the requested ref and returns per-file match counts with the first matching lines. Optionally restrict to a repository-relative path prefix. Follow up with read_repository_file to read a match.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, query: z.string().min(1).max(1000), mode: z.enum(['semantic', 'literal']).default('semantic'), ...refShape, path: z.string().max(1024).optional(), caseSensitive: z.boolean().optional(), ...pageShape }).strict(), run: async ({ principal, args }) => {
      await policy.repository(principal, args.repository);
      if (args.path) assertRelativePath(args.path);
      const branch = await defaultBranch(args.repository, args.branch);
      return ok(await retrieval(() => searchRepositoryFiles({ repository: args.repository, branch, ref: args.ref, query: args.query, mode: args.mode, path: args.path || undefined,
        caseSensitive: args.caseSensitive, offset: args.offset, limit: args.limit, authToken: principal.user.accessToken || undefined })));
    } });
  tools.push({ name: 'read_repository_file', description: 'Read a text file at a branch, ref or commit straight from git, in bounded line chunks, without cloning locally. Returns content with startLine, endLine, totalLines and a truncated flag; when truncated, continue from nextStartLine. Paths are repository-relative; binary files are rejected.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, path: z.string().min(1).max(1024), ...refShape, startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).optional(),
      maxLines: z.number().int().min(1).max(1000).default(800), maxBytes: z.number().int().min(1).max(500000).default(120000) }).strict(), run: async ({ principal, args }) => {
      await policy.repository(principal, args.repository);
      assertRelativePath(args.path);
      if (args.endLine !== undefined && args.endLine < args.startLine) throw new McpError('INVALID_INPUT', 'endLine must be greater than or equal to startLine.');
      const branch = await defaultBranch(args.repository, args.branch);
      return ok(await retrieval(() => readRepositoryFileContent({ repository: args.repository, branch, ref: args.ref, path: args.path, startLine: args.startLine, endLine: args.endLine,
        maxLines: args.maxLines, maxBytes: args.maxBytes, authToken: principal.user.accessToken || undefined })));
    } });
}
