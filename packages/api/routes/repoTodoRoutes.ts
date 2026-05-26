import { Request, Response } from 'express';
import {
  db,
  getCategoriesForRepository,
  createCategory,
  updateCategory,
  deleteCategory,
  batchReorderCategories,
  getTodosForRepository,
  getTodo,
  createTodo,
  updateTodo,
  deleteTodo,
  batchReorderTodos,
  type RepoTodo,
  type RepoTodoCategory,
  type RepoTodoCategoryRecord,
  type RepoTodoRecord,
} from '@propr/core';
import crypto from 'crypto';
import { isDemoMode } from '../demoMode.js';

interface CreateCategoryRequest {
  repository: string;
  name: string;
  orderIndex?: number;
}

interface UpdateCategoryRequest {
  name?: string;
  orderIndex?: number;
}

interface CreateTodoRequest {
  repository: string;
  categoryId?: string | null;
  content: string;
  orderIndex?: number;
}

interface UpdateTodoRequest {
  categoryId?: string | null;
  content?: string;
  orderIndex?: number;
  isCompleted?: boolean;
}

interface BatchReorderRequest {
  repository: string;
  items: Array<{
    id: string;
    orderIndex: number;
    categoryId?: string | null;
  }>;
}

function toCategoryDomain(record: RepoTodoCategoryRecord): RepoTodoCategory {
  return {
    categoryId: record.category_id,
    name: record.name,
    orderIndex: record.order_index,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}

function toTodoDomain(record: RepoTodoRecord): RepoTodo {
  return {
    todoId: record.todo_id,
    categoryId: record.category_id,
    content: record.content,
    orderIndex: record.order_index,
    isCompleted: Boolean(record.is_completed),
    linkedDraftId: record.linked_draft_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}

async function getDemoCategoriesForRepository(repository: string): Promise<RepoTodoCategory[]> {
  const records = await db<RepoTodoCategoryRecord>('repo_todo_categories')
    .where('repository', repository)
    .orderBy('user_id', 'asc')
    .orderBy('order_index', 'asc');
  return records.map(toCategoryDomain);
}

async function getDemoTodosForRepository(repository: string): Promise<RepoTodo[]> {
  const records = await db<RepoTodoRecord>('repo_todos')
    .where('repository', repository)
    .orderBy('user_id', 'asc')
    .orderBy('category_id', 'asc')
    .orderBy('order_index', 'asc');
  return records.map(toTodoDomain);
}

async function getDemoTodo(todoId: string): Promise<RepoTodo | null> {
  const record = await db<RepoTodoRecord>('repo_todos')
    .where('todo_id', todoId)
    .first();
  return record ? toTodoDomain(record) : null;
}

export function createRepoTodoRoutes() {
  // ============================================================================
  // Category Endpoints
  // ============================================================================

  /**
   * GET /api/repos/todos/categories?repository=owner/repo
   * Get all categories for a repository
   */
  async function getCategories(req: Request, res: Response): Promise<void> {
    try {
      const repository = req.query.repository as string;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository query parameter is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const categories = isDemoMode()
        ? await getDemoCategoriesForRepository(repository)
        : await getCategoriesForRepository(req.user.id, repository);
      res.json({ categories });
    } catch (error) {
      console.error('Error getting categories:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * POST /api/repos/todos/categories
   * Create a new category
   */
  async function createCategoryHandler(req: Request, res: Response): Promise<void> {
    try {
      const { repository, name, orderIndex } = req.body as CreateCategoryRequest;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required' });
        return;
      }

      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const categoryId = crypto.randomUUID();
      const category = await createCategory({
        categoryId,
        userId: req.user.id,
        repository,
        name,
        orderIndex,
      });

      res.status(201).json(category);
    } catch (error) {
      console.error('Error creating category:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * PUT /api/repos/todos/categories/:categoryId
   * Update a category
   */
  async function updateCategoryHandler(req: Request, res: Response): Promise<void> {
    try {
      const { categoryId } = req.params;
      const { name, orderIndex } = req.body as UpdateCategoryRequest;

      if (!categoryId) {
        res.status(400).json({ error: 'categoryId is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const category = await updateCategory(categoryId, req.user.id, { name, orderIndex });

      if (!category) {
        res.status(404).json({ error: 'Category not found' });
        return;
      }

      res.json(category);
    } catch (error) {
      console.error('Error updating category:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * DELETE /api/repos/todos/categories/:categoryId
   * Delete a category (moves todos to uncategorized)
   */
  async function deleteCategoryHandler(req: Request, res: Response): Promise<void> {
    try {
      const { categoryId } = req.params;

      if (!categoryId) {
        res.status(400).json({ error: 'categoryId is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const deleted = await deleteCategory(categoryId, req.user.id);
      res.json({ success: deleted });
    } catch (error) {
      console.error('Error deleting category:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * POST /api/repos/todos/categories/reorder
   * Batch reorder categories
   */
  async function reorderCategories(req: Request, res: Response): Promise<void> {
    try {
      const { repository, items } = req.body as BatchReorderRequest;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required' });
        return;
      }

      if (!Array.isArray(items)) {
        res.status(400).json({ error: 'items must be an array' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      await batchReorderCategories(req.user.id, repository, items);
      res.json({ success: true });
    } catch (error) {
      console.error('Error reordering categories:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  // ============================================================================
  // Todo Endpoints
  // ============================================================================

  /**
   * GET /api/repos/todos?repository=owner/repo
   * Get all todos for a repository
   */
  async function getTodos(req: Request, res: Response): Promise<void> {
    try {
      const repository = req.query.repository as string;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository query parameter is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const todos = isDemoMode()
        ? await getDemoTodosForRepository(repository)
        : await getTodosForRepository(req.user.id, repository);
      res.json({ todos });
    } catch (error) {
      console.error('Error getting todos:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * GET /api/repos/todos/:todoId
   * Get a single todo
   */
  async function getTodoHandler(req: Request, res: Response): Promise<void> {
    try {
      const { todoId } = req.params;

      if (!todoId) {
        res.status(400).json({ error: 'todoId is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const todo = isDemoMode()
        ? await getDemoTodo(todoId)
        : await getTodo(todoId, req.user.id);

      if (!todo) {
        res.status(404).json({ error: 'Todo not found' });
        return;
      }

      res.json(todo);
    } catch (error) {
      console.error('Error getting todo:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * POST /api/repos/todos
   * Create a new todo
   */
  async function createTodoHandler(req: Request, res: Response): Promise<void> {
    try {
      const { repository, categoryId, content, orderIndex } = req.body as CreateTodoRequest;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required' });
        return;
      }

      if (!content || typeof content !== 'string') {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const todoId = crypto.randomUUID();
      const todo = await createTodo({
        todoId,
        userId: req.user.id,
        repository,
        categoryId,
        content,
        orderIndex,
      });

      res.status(201).json(todo);
    } catch (error) {
      console.error('Error creating todo:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * PUT /api/repos/todos/:todoId
   * Update a todo
   */
  async function updateTodoHandler(req: Request, res: Response): Promise<void> {
    try {
      const { todoId } = req.params;
      const { categoryId, content, orderIndex, isCompleted } = req.body as UpdateTodoRequest;

      if (!todoId) {
        res.status(400).json({ error: 'todoId is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const todo = await updateTodo(todoId, req.user.id, {
        categoryId,
        content,
        orderIndex,
        isCompleted,
      });

      if (!todo) {
        res.status(404).json({ error: 'Todo not found' });
        return;
      }

      res.json(todo);
    } catch (error) {
      console.error('Error updating todo:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * DELETE /api/repos/todos/:todoId
   * Delete a todo
   */
  async function deleteTodoHandler(req: Request, res: Response): Promise<void> {
    try {
      const { todoId } = req.params;

      if (!todoId) {
        res.status(400).json({ error: 'todoId is required' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const deleted = await deleteTodo(todoId, req.user.id);
      res.json({ success: deleted });
    } catch (error) {
      console.error('Error deleting todo:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * POST /api/repos/todos/reorder
   * Batch reorder todos (supports moving between categories)
   */
  async function reorderTodos(req: Request, res: Response): Promise<void> {
    try {
      const { repository, items } = req.body as BatchReorderRequest;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required' });
        return;
      }

      if (!Array.isArray(items)) {
        res.status(400).json({ error: 'items must be an array' });
        return;
      }

      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      await batchReorderTodos(req.user.id, repository, items);
      res.json({ success: true });
    } catch (error) {
      console.error('Error reordering todos:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  return {
    // Category endpoints
    getCategories,
    createCategory: createCategoryHandler,
    updateCategory: updateCategoryHandler,
    deleteCategory: deleteCategoryHandler,
    reorderCategories,
    // Todo endpoints
    getTodos,
    getTodo: getTodoHandler,
    createTodo: createTodoHandler,
    updateTodo: updateTodoHandler,
    deleteTodo: deleteTodoHandler,
    reorderTodos,
  };
}
