import { addConfigurationTools } from './toolsConfiguration.js';
import { configRevision } from '../routes/configRevision.js';
import { z } from 'zod';
import { loadMonitoredReposRaw } from '@propr/core';
import { REASONING_LEVELS, REVIEW_CONTEXT_BUDGET_PERCENT_MAX, REVIEW_CONTEXT_BUDGET_PERCENT_MIN, REVIEW_CONTEXT_BUDGET_PERCENT_STEP, REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MAX, REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MIN } from '@propr/shared';
import { createUserRepoPreferencesRoutes } from '../routes/userRepoPreferencesRoutes.js';
import type { createRepoTodoRoutes } from '../routes/repoTodoRoutes.js';
import type { createConfigRoutes } from '../routes/configRoutes.js';
import type { createAgentRuntimeRoutes } from '../routes/agentRuntimeRoutes.js';
import { callWorkflow } from './adapter.js';
import { McpError } from './config.js';
import { type McpTool, type ToolDeps, mutationShape, pageShape, repositorySchema, textSchema, idSchema, ok, workflow } from './tools.js';
import { summarizeTodo } from './listSummaries.js';

interface Handlers {
  todos: ReturnType<typeof createRepoTodoRoutes>;
  config: ReturnType<typeof createConfigRoutes>;
  runtime: ReturnType<typeof createAgentRuntimeRoutes>;
}

export function addManagementTools(tools: McpTool[], deps: ToolDeps, { todos, config, runtime }: Handlers): void {
  const { db } = deps;
  const todoTarget = { table: 'repo_todos', column: 'todo_id', arg: 'todoId', owner: 'user_id' };
  const categoryTarget = { table: 'repo_todo_categories', column: 'category_id', arg: 'categoryId', owner: 'user_id' };
  tools.push({ name: 'list_todos', description: 'List compact summaries of your repository TODOs and their linked plans.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema, ...pageShape }).strict(), run: async ({ principal, args }) => {
    const rows = await db('repo_todos as todo')
      .leftJoin('repo_todo_categories as category', join => join.on('category.category_id', '=', 'todo.category_id').andOn('category.user_id', '=', 'todo.user_id'))
      .leftJoin('task_drafts as plan', join => join.on('plan.draft_id', '=', 'todo.linked_draft_id').andOn('plan.user_id', '=', 'todo.user_id'))
      .where({ 'todo.repository': args.repository, 'todo.user_id': principal.user.id })
      .select('todo.todo_id', 'todo.repository', 'todo.content', 'todo.is_completed', 'todo.category_id',
        'category.name as category_name', 'todo.linked_draft_id', 'plan.name as linked_plan_name',
        'plan.status as linked_plan_status', 'todo.order_index', 'todo.created_at', 'todo.updated_at')
      .orderBy('todo.order_index').orderBy('todo.id').offset(args.offset).limit(args.limit);
    const items = rows.map(row => summarizeTodo(row));
    return ok({ items, nextOffset: rows.length === args.limit ? args.offset + args.limit : null });
  } });
  tools.push({ name: 'list_todo_categories', description: 'List your repository TODO categories.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema, ...pageShape }).strict(), run: async ({ principal, args }) => {
    const items = await db('repo_todo_categories').where({ repository: args.repository, user_id: principal.user.id }).orderBy('order_index').orderBy('id').offset(args.offset).limit(args.limit);
    return ok({ items, nextOffset: items.length === args.limit ? args.offset + args.limit : null });
  } });
  workflow(tools, { name: 'get_todo', description: 'Read one of your TODOs.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema, todoId: z.uuid() }).strict(), target: todoTarget }, todos.getTodo, args => ({ params: { todoId: args.todoId } }));
  workflow(tools, { name: 'create_todo', description: 'Create a repository TODO without starting work.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, content: textSchema }).strict() }, todos.createTodo, args => ({ body: { repository: args.repository, content: args.content } }));
  workflow(tools, { name: 'update_todo', description: 'Edit or complete one of your repository TODOs.', scope: 'plan', target: todoTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, todoId: z.uuid(), content: textSchema.optional(), isCompleted: z.boolean().optional(), orderIndex: z.number().int().min(0).optional() }).strict() }, todos.updateTodo, args => ({ params: { todoId: args.todoId }, body: { content: args.content, isCompleted: args.isCompleted, orderIndex: args.orderIndex } }));
  workflow(tools, { name: 'delete_todo', description: 'Delete your TODO.', scope: 'plan', target: todoTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, todoId: z.uuid() }).strict() }, todos.deleteTodo, args => ({ params: { todoId: args.todoId } }));
  workflow(tools, { name: 'create_todo_category', description: 'Create a TODO category.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, name: z.string().min(1).max(255), orderIndex: z.number().int().min(0).optional() }).strict() }, todos.createCategory, args => ({ body: args }));
  workflow(tools, { name: 'update_todo_category', description: 'Rename or reorder your TODO category.', scope: 'plan', target: categoryTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, categoryId: z.uuid(), name: z.string().min(1).max(255).optional(), orderIndex: z.number().int().min(0).optional() }).strict() }, todos.updateCategory, args => ({ params: { categoryId: args.categoryId }, body: { name: args.name, orderIndex: args.orderIndex } }));
  workflow(tools, { name: 'delete_todo_category', description: 'Delete your TODO category using the existing product semantics.', scope: 'plan', target: categoryTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, categoryId: z.uuid() }).strict() }, todos.deleteCategory, args => ({ params: { categoryId: args.categoryId } }));
  tools.push({ name: 'move_todo', description: 'Move your TODO into an owned category in the same repository, or uncategorize it.', scope: 'plan', target: todoTarget, schema: z.object({ ...mutationShape, repository: repositorySchema, todoId: z.uuid(), categoryId: z.uuid().nullable(), orderIndex: z.number().int().min(0).default(0) }).strict(), run: async ({ principal, args }) => {
    if (args.categoryId && !await db('repo_todo_categories').where({ category_id: args.categoryId, user_id: principal.user.id, repository: args.repository }).first()) throw new McpError('NOT_FOUND', 'Category not found in this repository.', 404);
    return callWorkflow(todos.updateTodo, principal, { params: { todoId: args.todoId }, body: { categoryId: args.categoryId, orderIndex: args.orderIndex } });
  } });
  const preferences = createUserRepoPreferencesRoutes();
  tools.push({ name: 'get_repository_preferences', description: 'Read your star/hidden preferences for a repository.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema }).strict(), run: async ({ principal, args }) => {
    const response = await callWorkflow(preferences.getRepoPreferences, principal, {});
    return ok({ repository: args.repository, preferences: (response.data as { preferences: Record<string, unknown> }).preferences[args.repository] || {} });
  } });
  tools.push({ name: 'update_repository_preferences', description: 'Change your repository star/hidden preferences.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema, starred: z.boolean().optional(), hidden: z.boolean().optional() }).strict(), run: async ({ principal, args }) => {
    await callWorkflow(preferences.updateRepoPreferences, principal, { body: { preferences: { [args.repository]: { starred: args.starred, hidden: args.hidden } } } });
    return ok({ repository: args.repository, updated: true });
  } });

  const settingsShape = { worker_concurrency: z.number().int().min(1).max(100).optional(), analysis_model_fast: z.string().max(256).optional(), planner_context_model: z.string().max(256).optional(), pr_review_prompt: z.string().max(65536).optional(), pr_review_context_enabled: z.boolean().optional(), pr_review_context_model: z.string().max(256).optional(), pr_review_max_context_tokens: z.union([z.literal(0), z.number().int().min(REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MIN).max(REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MAX)]).optional().describe('Legacy absolute review input token cap; 0 removes it. The lower of this and the percentage budget applies.'), pr_review_context_budget_percent: z.number().int().min(REVIEW_CONTEXT_BUDGET_PERCENT_MIN).max(REVIEW_CONTEXT_BUDGET_PERCENT_MAX).multipleOf(REVIEW_CONTEXT_BUDGET_PERCENT_STEP).optional().describe('Review context budget: percentage (10-100 in steps of 10) of each reviewer\'s safe input capacity.'), default_agent_alias: idSchema.optional(), planner_generation_model: idSchema.optional(), model_reasoning_level: z.enum(REASONING_LEVELS).optional(), pr_review_model: z.string().max(256).optional(), ultrafix_rating_goal: z.number().int().min(1).max(10).optional(), ultrafix_max_cycles: z.number().int().min(1).max(10).optional(), ultrafix_pause_seconds: z.number().int().min(0).max(3600).optional(), auto_followup_score_threshold: z.number().int().min(0).max(9).optional(), auto_resolve_merge_conflicts: z.boolean().optional() };
  tools.push({ name: 'get_execution_settings', description: 'Read supported execution/model settings without secrets.', scope: 'read', readOnly: true, schema: z.object({}).strict(), run: async ({ principal }) => {
    const settings = (await callWorkflow(config.getSettings, principal, {})).data as Record<string, unknown>;
    return ok(Object.fromEntries(Object.keys(settingsShape).filter(key => key in settings).map(key => [key, settings[key]])));
  } });
  workflow(tools, { name: 'update_execution_settings', description: 'Update supported execution/model settings. Requires instance.manage_settings.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, settings: z.object(settingsShape).strict() }).strict() }, config.postSettings, args => ({ body: { settings: args.settings } }));
  workflow(tools, { name: 'index_repository', description: 'Queue indexing for an explicit repository and branch through the existing indexing workflow.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, repository: repositorySchema, baseBranch: idSchema, fullReindex: z.boolean().default(false), ignoreCooldown: z.boolean().default(false) }).strict() }, config.triggerIndexing, args => ({ body: { repository: args.repository, baseBranch: args.baseBranch, fullReindex: args.fullReindex, ignoreCooldown: args.ignoreCooldown } }));
  workflow(tools, { name: 'stop_repository_indexing', description: 'Request cancellation of indexing for an explicit repository and branch.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, repository: repositorySchema, branch: idSchema }).strict() }, config.stopIndexing, args => ({ body: { repository: args.repository, branch: args.branch } }));
  workflow(tools, { name: 'get_runtime_configuration', description: 'Read supported agent runtime packages and build state.', scope: 'manage', permission: 'instance.manage_runtime', readOnly: true, schema: z.object({}).strict() }, runtime.getRuntimePackages, () => ({}));
  workflow(tools, { name: 'update_runtime_configuration', description: 'Apply validated runtime packages through the existing runtime builder.', scope: 'manage', permission: 'instance.manage_runtime', schema: z.object({ ...mutationShape, packages: z.array(z.string().min(1).max(200)).max(100) }).strict() }, runtime.putRuntimePackages, args => ({ body: { packages: args.packages } }));
  tools.push({ name: 'get_repository_configuration', description: 'Read a configured repository’s non-secret operational settings.', scope: 'manage', permission: 'instance.manage_settings', readOnly: true, schema: z.object({ repository: repositorySchema }).strict(), run: async ({ args }) => {
    const repo = (await loadMonitoredReposRaw()).find(repo => repo.name.toLowerCase() === args.repository.toLowerCase());
    if (!repo) throw new McpError('NOT_FOUND', 'Configured repository no longer exists.', 404);
    return ok(repo);
  } });
  tools.push({ name: 'update_repository_configuration', description: 'Update branch, alias, enabled state, CI followup, notifications or visual preview policy for a specific configured repository.', scope: 'manage', permission: 'instance.manage_settings', schema: z.object({ ...mutationShape, repository: repositorySchema, baseBranch: idSchema.optional(), alias: idSchema.optional(), enabled: z.boolean().optional(), autoFollowupOnFailedCi: z.boolean().optional(), cancelCiDuringFollowup: z.boolean().optional(), cancelCiDuringFollowupWorkflows: z.array(z.string().min(1).max(255)).max(50).optional(), notificationsEnabled: z.boolean().optional(), visualPreview: z.object({ enabled: z.boolean(), types: z.array(z.enum(['image', 'video'])).min(1).max(2), instructions: z.string().max(8192).optional() }).strict().optional() }).strict(), run: async ({ principal, args }) => {
    const repos = await loadMonitoredReposRaw();
    const patch = Object.fromEntries(['baseBranch', 'alias', 'enabled', 'autoFollowupOnFailedCi', 'cancelCiDuringFollowup', 'cancelCiDuringFollowupWorkflows', 'notificationsEnabled', 'visualPreview'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    const updated = repos.map(repo => repo.name.toLowerCase() === args.repository.toLowerCase() ? { ...repo, ...patch } : repo);
    await callWorkflow(config.postRepos, principal, { body: { repos_to_monitor: updated, expectedRevision: configRevision(repos) } });
    return ok({ repository: args.repository, updated: true });
  } });
  addConfigurationTools(tools, deps, config);
}
