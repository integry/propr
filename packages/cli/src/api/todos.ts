/**
 * Repository To-Dos API
 *
 * Functions for interacting with the ProPR backend to-do endpoints.
 */

import { ApiClient, createApiClient } from "./client.js";

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

export interface RepoTodoCategory {
  categoryId: string;
  name: string;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListTodosResponse {
  todos: RepoTodo[];
}

export interface ListCategoriesResponse {
  categories: RepoTodoCategory[];
}

export async function listTodos(repository: string, client?: ApiClient): Promise<ListTodosResponse> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<ListTodosResponse>("/api/repos/todos", {
    params: { repository },
  });
  return response.data;
}

export async function getTodo(todoId: string, client?: ApiClient): Promise<RepoTodo> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<RepoTodo>(`/api/repos/todos/${todoId}`);
  return response.data;
}

export async function createTodo(params: {
  repository: string;
  content: string;
  categoryId?: string | null;
}, client?: ApiClient): Promise<RepoTodo> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.post<RepoTodo>("/api/repos/todos", {
    body: params,
  });
  return response.data;
}

export async function updateTodo(
  todoId: string,
  updates: {
    content?: string;
    isCompleted?: boolean;
    categoryId?: string | null;
  },
  client?: ApiClient
): Promise<RepoTodo> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.put<RepoTodo>(`/api/repos/todos/${todoId}`, {
    body: updates,
  });
  return response.data;
}

export async function deleteTodo(todoId: string, client?: ApiClient): Promise<{ success: boolean }> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.delete<{ success: boolean }>(`/api/repos/todos/${todoId}`);
  return response.data;
}

export async function listCategories(repository: string, client?: ApiClient): Promise<ListCategoriesResponse> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<ListCategoriesResponse>("/api/repos/todos/categories", {
    params: { repository },
  });
  return response.data;
}

export async function createCategory(params: {
  repository: string;
  name: string;
}, client?: ApiClient): Promise<RepoTodoCategory> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.post<RepoTodoCategory>("/api/repos/todos/categories", {
    body: params,
  });
  return response.data;
}

export async function updateCategory(
  categoryId: string,
  updates: { name?: string },
  client?: ApiClient
): Promise<RepoTodoCategory> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.put<RepoTodoCategory>(`/api/repos/todos/categories/${categoryId}`, {
    body: updates,
  });
  return response.data;
}

export async function deleteCategory(categoryId: string, client?: ApiClient): Promise<{ success: boolean }> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.delete<{ success: boolean }>(`/api/repos/todos/categories/${categoryId}`);
  return response.data;
}

export interface BatchReorderItem {
  id: string;
  orderIndex: number;
  categoryId?: string | null;
}

export async function reorderTodos(
  repository: string,
  items: BatchReorderItem[],
  client?: ApiClient
): Promise<{ success: boolean }> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.post<{ success: boolean }>("/api/repos/todos/reorder", {
    body: { repository, items },
  });
  return response.data;
}

export async function reorderCategories(
  repository: string,
  items: { id: string; orderIndex: number }[],
  client?: ApiClient
): Promise<{ success: boolean }> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.post<{ success: boolean }>("/api/repos/todos/categories/reorder", {
    body: { repository, items },
  });
  return response.data;
}
