/**
 * Repository To-Dos API
 *
 * Functions for interacting with the ProPR backend to-do endpoints.
 */

import { createApiClient } from "./client.js";

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

export async function listTodos(repository: string): Promise<ListTodosResponse> {
  const client = await createApiClient();
  const response = await client.get<ListTodosResponse>("/api/repos/todos", {
    params: { repository },
  });
  return response.data;
}

export async function getTodo(todoId: string): Promise<RepoTodo> {
  const client = await createApiClient();
  const response = await client.get<RepoTodo>(`/api/repos/todos/${todoId}`);
  return response.data;
}

export async function createTodo(params: {
  repository: string;
  content: string;
  categoryId?: string | null;
}): Promise<RepoTodo> {
  const client = await createApiClient();
  const response = await client.post<RepoTodo>("/api/repos/todos", {
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
  }
): Promise<RepoTodo> {
  const client = await createApiClient();
  const response = await client.put<RepoTodo>(`/api/repos/todos/${todoId}`, {
    body: updates,
  });
  return response.data;
}

export async function deleteTodo(todoId: string): Promise<{ success: boolean }> {
  const client = await createApiClient();
  const response = await client.delete<{ success: boolean }>(`/api/repos/todos/${todoId}`);
  return response.data;
}

export async function listCategories(repository: string): Promise<ListCategoriesResponse> {
  const client = await createApiClient();
  const response = await client.get<ListCategoriesResponse>("/api/repos/todos/categories", {
    params: { repository },
  });
  return response.data;
}

export async function createCategory(params: {
  repository: string;
  name: string;
}): Promise<RepoTodoCategory> {
  const client = await createApiClient();
  const response = await client.post<RepoTodoCategory>("/api/repos/todos/categories", {
    body: params,
  });
  return response.data;
}

export async function updateCategory(
  categoryId: string,
  updates: { name?: string }
): Promise<RepoTodoCategory> {
  const client = await createApiClient();
  const response = await client.put<RepoTodoCategory>(`/api/repos/todos/categories/${categoryId}`, {
    body: updates,
  });
  return response.data;
}

export async function deleteCategory(categoryId: string): Promise<{ success: boolean }> {
  const client = await createApiClient();
  const response = await client.delete<{ success: boolean }>(`/api/repos/todos/categories/${categoryId}`);
  return response.data;
}

export interface BatchReorderItem {
  id: string;
  orderIndex: number;
  categoryId?: string | null;
}

export async function reorderTodos(
  repository: string,
  items: BatchReorderItem[]
): Promise<{ success: boolean }> {
  const client = await createApiClient();
  const response = await client.post<{ success: boolean }>("/api/repos/todos/reorder", {
    body: { repository, items },
  });
  return response.data;
}

export async function reorderCategories(
  repository: string,
  items: { id: string; orderIndex: number }[]
): Promise<{ success: boolean }> {
  const client = await createApiClient();
  const response = await client.post<{ success: boolean }>("/api/repos/todos/categories/reorder", {
    body: { repository, items },
  });
  return response.data;
}
