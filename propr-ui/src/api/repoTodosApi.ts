// Repository To-Dos API
import { API_BASE_URL, handleApiResponse } from './proprApi';

/**
 * Represents a to-do category for organizing to-dos
 */
export interface RepoTodoCategory {
  categoryId: string;
  name: string;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Represents a single to-do item
 */
export interface RepoTodo {
  todoId: string;
  categoryId: string | null;
  content: string;
  orderIndex: number;
  isCompleted: boolean;
  linkedDraftId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Parameters for creating a new category
 */
export interface CreateCategoryParams {
  repository: string;
  name: string;
  orderIndex?: number;
}

/**
 * Parameters for updating a category
 */
export interface UpdateCategoryParams {
  name?: string;
  orderIndex?: number;
}

/**
 * Parameters for creating a new to-do
 */
export interface CreateTodoParams {
  repository: string;
  categoryId?: string | null;
  content: string;
  orderIndex?: number;
}

/**
 * Parameters for updating a to-do
 */
export interface UpdateTodoParams {
  categoryId?: string | null;
  content?: string;
  orderIndex?: number;
  isCompleted?: boolean;
}

/**
 * Item for batch reordering
 */
export interface BatchReorderItem {
  id: string;
  orderIndex: number;
  categoryId?: string | null;
}

/**
 * Parameters for batch reordering
 */
export interface BatchReorderParams {
  repository: string;
  items: BatchReorderItem[];
}

// ============================================================================
// Category Endpoints
// ============================================================================

/**
 * Get all categories for a repository.
 *
 * @param repository - The full repository name (e.g., "owner/repo")
 * @returns Array of categories ordered by orderIndex
 */
export const getCategories = async (repository: string): Promise<RepoTodoCategory[]> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/todos/categories?repository=${encodeURIComponent(repository)}`,
    {
      method: 'GET',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  const data = await response.json();
  return data.categories || [];
};

/**
 * Create a new category.
 *
 * @param params - The category creation parameters
 * @returns The created category
 */
export const createCategory = async (params: CreateCategoryParams): Promise<RepoTodoCategory> => {
  const response = await fetch(`${API_BASE_URL}/api/repos/todos/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/**
 * Update a category.
 *
 * @param categoryId - The category ID to update
 * @param params - The update parameters
 * @returns The updated category
 */
export const updateCategory = async (
  categoryId: string,
  params: UpdateCategoryParams
): Promise<RepoTodoCategory> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/todos/categories/${encodeURIComponent(categoryId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  return response.json();
};

/**
 * Delete a category. Moves todos to uncategorized.
 *
 * @param categoryId - The category ID to delete
 * @returns Whether the deletion was successful
 */
export const deleteCategory = async (categoryId: string): Promise<boolean> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/todos/categories/${encodeURIComponent(categoryId)}`,
    {
      method: 'DELETE',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  const data = await response.json();
  return data.success;
};

/**
 * Batch reorder categories.
 *
 * @param params - The reorder parameters
 * @returns Whether the reorder was successful
 */
export const reorderCategories = async (params: BatchReorderParams): Promise<boolean> => {
  const response = await fetch(`${API_BASE_URL}/api/repos/todos/categories/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    credentials: 'include'
  });
  await handleApiResponse(response);
  const data = await response.json();
  return data.success;
};

// ============================================================================
// Todo Endpoints
// ============================================================================

/**
 * Get all to-dos for a repository.
 *
 * @param repository - The full repository name (e.g., "owner/repo")
 * @returns Array of to-dos ordered by category and orderIndex
 */
export const getTodos = async (repository: string): Promise<RepoTodo[]> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/todos?repository=${encodeURIComponent(repository)}`,
    {
      method: 'GET',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  const data = await response.json();
  return data.todos || [];
};

/**
 * Get a single to-do by ID.
 *
 * @param todoId - The to-do ID
 * @returns The to-do if found
 */
export const getTodo = async (todoId: string): Promise<RepoTodo> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/todos/${encodeURIComponent(todoId)}`,
    {
      method: 'GET',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  return response.json();
};

/**
 * Create a new to-do.
 *
 * @param params - The to-do creation parameters
 * @returns The created to-do
 */
export const createTodo = async (params: CreateTodoParams): Promise<RepoTodo> => {
  const response = await fetch(`${API_BASE_URL}/api/repos/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/**
 * Update a to-do.
 *
 * @param todoId - The to-do ID to update
 * @param params - The update parameters
 * @returns The updated to-do
 */
export const updateTodo = async (
  todoId: string,
  params: UpdateTodoParams
): Promise<RepoTodo> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/todos/${encodeURIComponent(todoId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  return response.json();
};

/**
 * Delete a to-do.
 *
 * @param todoId - The to-do ID to delete
 * @returns Whether the deletion was successful
 */
export const deleteTodo = async (todoId: string): Promise<boolean> => {
  const response = await fetch(
    `${API_BASE_URL}/api/repos/todos/${encodeURIComponent(todoId)}`,
    {
      method: 'DELETE',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  const data = await response.json();
  return data.success;
};

/**
 * Batch reorder to-dos. Supports moving between categories.
 *
 * @param params - The reorder parameters
 * @returns Whether the reorder was successful
 */
export const reorderTodos = async (params: BatchReorderParams): Promise<boolean> => {
  const response = await fetch(`${API_BASE_URL}/api/repos/todos/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    credentials: 'include'
  });
  await handleApiResponse(response);
  const data = await response.json();
  return data.success;
};
