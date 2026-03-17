/**
 * Type definitions for repository to-dos and categories.
 */

export interface RepoTodoCategoryRecord {
  id: number;
  category_id: string;
  user_id: string;
  repository: string;
  name: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface RepoTodoRecord {
  id: number;
  todo_id: string;
  user_id: string;
  repository: string;
  category_id: string | null;
  content: string;
  order_index: number;
  is_completed: boolean;
  linked_draft_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepoTodoCategory {
  categoryId: string;
  name: string;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

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

export interface CreateCategoryParams {
  categoryId: string;
  userId: string;
  repository: string;
  name: string;
  orderIndex?: number;
}

export interface UpdateCategoryParams {
  name?: string;
  orderIndex?: number;
}

export interface CreateTodoParams {
  todoId: string;
  userId: string;
  repository: string;
  categoryId?: string | null;
  content: string;
  orderIndex?: number;
}

export interface UpdateTodoParams {
  categoryId?: string | null;
  content?: string;
  orderIndex?: number;
  isCompleted?: boolean;
  linkedDraftId?: string | null;
}

export interface BatchReorderItem {
  id: string;
  orderIndex: number;
  categoryId?: string | null;
}
