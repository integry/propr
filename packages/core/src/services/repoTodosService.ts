/**
 * Service for managing repository to-dos and categories.
 */

import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import type { RepoTodoCategoryRecord, RepoTodoRecord, RepoTodoCategory, RepoTodo, CreateCategoryParams, UpdateCategoryParams, CreateTodoParams, UpdateTodoParams, BatchReorderItem } from './repoTodosTypes.js';

export type { RepoTodoCategoryRecord, RepoTodoRecord, RepoTodoCategory, RepoTodo, CreateCategoryParams, UpdateCategoryParams, CreateTodoParams, UpdateTodoParams, BatchReorderItem } from './repoTodosTypes.js';

// Helper functions to convert database records to domain objects
function toCategoryDomain(record: RepoTodoCategoryRecord): RepoTodoCategory {
  return { categoryId: record.category_id, name: record.name, orderIndex: record.order_index, createdAt: record.created_at, updatedAt: record.updated_at };
}

function toTodoDomain(record: RepoTodoRecord): RepoTodo {
  return { todoId: record.todo_id, categoryId: record.category_id, content: record.content, orderIndex: record.order_index, isCompleted: Boolean(record.is_completed), linkedDraftId: record.linked_draft_id, createdAt: record.created_at, updatedAt: record.updated_at };
}

/** Get all categories for a user and repository, ordered by order_index. */
export async function getCategoriesForRepository(userId: string, repository: string): Promise<RepoTodoCategory[]> {
  try {
    const records = await db<RepoTodoCategoryRecord>('repo_todo_categories').where('user_id', userId).andWhere('repository', repository).orderBy('order_index', 'asc');
    return records.map(toCategoryDomain);
  } catch (error) {
    logger.error({ error: (error as Error).message, userId, repository }, 'Failed to get categories');
    throw error;
  }
}

/** Create a new category. */
export async function createCategory(params: CreateCategoryParams): Promise<RepoTodoCategory> {
  try {
    let orderIndex = params.orderIndex;
    if (orderIndex === undefined) {
      const maxResult = await db<RepoTodoCategoryRecord>('repo_todo_categories').where('user_id', params.userId).andWhere('repository', params.repository).max('order_index as maxOrder').first() as { maxOrder: number | null } | undefined;
      orderIndex = ((maxResult?.maxOrder as number | null) ?? -1) + 1;
    }
    await db<RepoTodoCategoryRecord>('repo_todo_categories').insert({ category_id: params.categoryId, user_id: params.userId, repository: params.repository, name: params.name, order_index: orderIndex });
    const record = await db<RepoTodoCategoryRecord>('repo_todo_categories').where('category_id', params.categoryId).first();
    logger.debug({ categoryId: params.categoryId, repository: params.repository }, 'Category created');
    return toCategoryDomain(record!);
  } catch (error) {
    logger.error({ error: (error as Error).message, params }, 'Failed to create category');
    throw error;
  }
}

/** Update a category. */
export async function updateCategory(categoryId: string, userId: string, updates: UpdateCategoryParams): Promise<RepoTodoCategory | null> {
  try {
    const updateData: Record<string, unknown> = { updated_at: db.fn.now() };
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.orderIndex !== undefined) updateData.order_index = updates.orderIndex;
    await db<RepoTodoCategoryRecord>('repo_todo_categories').where('category_id', categoryId).andWhere('user_id', userId).update(updateData);
    const record = await db<RepoTodoCategoryRecord>('repo_todo_categories').where('category_id', categoryId).first();
    if (!record) return null;
    logger.debug({ categoryId, updates }, 'Category updated');
    return toCategoryDomain(record);
  } catch (error) {
    logger.error({ error: (error as Error).message, categoryId, updates }, 'Failed to update category');
    throw error;
  }
}

/** Delete a category and move its todos to uncategorized. */
export async function deleteCategory(categoryId: string, userId: string): Promise<boolean> {
  try {
    await db<RepoTodoRecord>('repo_todos').where('category_id', categoryId).andWhere('user_id', userId).update({ category_id: null, updated_at: db.fn.now() });
    const deleted = await db<RepoTodoCategoryRecord>('repo_todo_categories').where('category_id', categoryId).andWhere('user_id', userId).del();
    logger.debug({ categoryId, deleted }, 'Category deleted');
    return deleted > 0;
  } catch (error) {
    logger.error({ error: (error as Error).message, categoryId }, 'Failed to delete category');
    throw error;
  }
}

/** Batch reorder categories. */
export async function batchReorderCategories(userId: string, repository: string, items: BatchReorderItem[]): Promise<void> {
  try {
    await db.transaction(async (trx) => {
      for (const item of items) {
        await trx<RepoTodoCategoryRecord>('repo_todo_categories').where('category_id', item.id).andWhere('user_id', userId).andWhere('repository', repository).update({ order_index: item.orderIndex, updated_at: db.fn.now() });
      }
    });
    logger.debug({ userId, repository, itemCount: items.length }, 'Categories reordered');
  } catch (error) {
    logger.error({ error: (error as Error).message, userId, repository }, 'Failed to reorder categories');
    throw error;
  }
}

/** Get all todos for a user and repository, grouped by category and ordered. */
export async function getTodosForRepository(userId: string, repository: string): Promise<RepoTodo[]> {
  try {
    const records = await db<RepoTodoRecord>('repo_todos').where('user_id', userId).andWhere('repository', repository).orderBy('category_id', 'asc').orderBy('order_index', 'asc');
    return records.map(toTodoDomain);
  } catch (error) {
    logger.error({ error: (error as Error).message, userId, repository }, 'Failed to get todos');
    throw error;
  }
}

/** Get a single todo by ID. */
export async function getTodo(todoId: string, userId: string): Promise<RepoTodo | null> {
  try {
    const record = await db<RepoTodoRecord>('repo_todos').where('todo_id', todoId).andWhere('user_id', userId).first();
    return record ? toTodoDomain(record) : null;
  } catch (error) {
    logger.error({ error: (error as Error).message, todoId }, 'Failed to get todo');
    throw error;
  }
}

/** Create a new todo. */
export async function createTodo(params: CreateTodoParams): Promise<RepoTodo> {
  try {
    let orderIndex = params.orderIndex;
    if (orderIndex === undefined) {
      const query = db<RepoTodoRecord>('repo_todos').where('user_id', params.userId).andWhere('repository', params.repository);
      if (params.categoryId) query.andWhere('category_id', params.categoryId);
      else query.whereNull('category_id');
      const maxResult = await query.max('order_index as maxOrder').first() as { maxOrder: number | null } | undefined;
      orderIndex = ((maxResult?.maxOrder as number | null) ?? -1) + 1;
    }
    await db<RepoTodoRecord>('repo_todos').insert({ todo_id: params.todoId, user_id: params.userId, repository: params.repository, category_id: params.categoryId ?? null, content: params.content, order_index: orderIndex, is_completed: false, linked_draft_id: null });
    const record = await db<RepoTodoRecord>('repo_todos').where('todo_id', params.todoId).first();
    logger.debug({ todoId: params.todoId, repository: params.repository }, 'Todo created');
    return toTodoDomain(record!);
  } catch (error) {
    logger.error({ error: (error as Error).message, params }, 'Failed to create todo');
    throw error;
  }
}

/** Update a todo. */
export async function updateTodo(todoId: string, userId: string, updates: UpdateTodoParams): Promise<RepoTodo | null> {
  try {
    const updateData: Record<string, unknown> = { updated_at: db.fn.now() };
    if (updates.categoryId !== undefined) updateData.category_id = updates.categoryId;
    if (updates.content !== undefined) updateData.content = updates.content;
    if (updates.orderIndex !== undefined) updateData.order_index = updates.orderIndex;
    if (updates.isCompleted !== undefined) updateData.is_completed = updates.isCompleted;
    if (updates.linkedDraftId !== undefined) updateData.linked_draft_id = updates.linkedDraftId;
    await db<RepoTodoRecord>('repo_todos').where('todo_id', todoId).andWhere('user_id', userId).update(updateData);
    const record = await db<RepoTodoRecord>('repo_todos').where('todo_id', todoId).first();
    if (!record) return null;
    logger.debug({ todoId, updates }, 'Todo updated');
    return toTodoDomain(record);
  } catch (error) {
    logger.error({ error: (error as Error).message, todoId, updates }, 'Failed to update todo');
    throw error;
  }
}

/** Delete a todo. */
export async function deleteTodo(todoId: string, userId: string): Promise<boolean> {
  try {
    const deleted = await db<RepoTodoRecord>('repo_todos').where('todo_id', todoId).andWhere('user_id', userId).del();
    logger.debug({ todoId, deleted }, 'Todo deleted');
    return deleted > 0;
  } catch (error) {
    logger.error({ error: (error as Error).message, todoId }, 'Failed to delete todo');
    throw error;
  }
}

/** Batch reorder todos (supports moving between categories). */
export async function batchReorderTodos(userId: string, repository: string, items: BatchReorderItem[]): Promise<void> {
  try {
    await db.transaction(async (trx) => {
      for (const item of items) {
        const updateData: Record<string, unknown> = { order_index: item.orderIndex, updated_at: db.fn.now() };
        if (item.categoryId !== undefined) updateData.category_id = item.categoryId;
        await trx<RepoTodoRecord>('repo_todos').where('todo_id', item.id).andWhere('user_id', userId).andWhere('repository', repository).update(updateData);
      }
    });
    logger.debug({ userId, repository, itemCount: items.length }, 'Todos reordered');
  } catch (error) {
    logger.error({ error: (error as Error).message, userId, repository }, 'Failed to reorder todos');
    throw error;
  }
}

/** Link multiple todos to a draft when creating a plan from todos. */
export async function linkTodosToDraft(todoIds: string[], draftId: string, userId: string): Promise<number> {
  try {
    const updated = await db<RepoTodoRecord>('repo_todos').whereIn('todo_id', todoIds).andWhere('user_id', userId).update({ linked_draft_id: draftId, updated_at: db.fn.now() });
    logger.info({ todoIds, draftId, updated }, 'Linked todos to draft');
    return updated;
  } catch (error) {
    logger.error({ error: (error as Error).message, todoIds, draftId }, 'Failed to link todos to draft');
    throw error;
  }
}

/** Mark all todos linked to a draft as completed. Called when a draft/plan is merged. */
export async function completeTodosForDraft(draftId: string): Promise<number> {
  try {
    const updated = await db<RepoTodoRecord>('repo_todos').where('linked_draft_id', draftId).update({ is_completed: true, updated_at: db.fn.now() });
    logger.info({ draftId, updated }, 'Completed todos linked to merged draft');
    return updated;
  } catch (error) {
    logger.error({ error: (error as Error).message, draftId }, 'Failed to complete todos for draft');
    throw error;
  }
}

/** Get todos linked to a specific draft. */
export async function getTodosForDraft(draftId: string): Promise<RepoTodo[]> {
  try {
    const records = await db<RepoTodoRecord>('repo_todos').where('linked_draft_id', draftId).orderBy('created_at', 'asc');
    return records.map(toTodoDomain);
  } catch (error) {
    logger.error({ error: (error as Error).message, draftId }, 'Failed to get todos for draft');
    throw error;
  }
}
