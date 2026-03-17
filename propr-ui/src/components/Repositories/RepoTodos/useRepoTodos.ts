import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  getCategories,
  getTodos,
  createCategory,
  updateCategory,
  deleteCategory,
  createTodo,
  updateTodo,
  deleteTodo,
  reorderTodos,
  RepoTodoCategory,
  RepoTodo,
  BatchReorderItem,
} from '../../../api/repoTodosApi';
import { arrayMove } from '@dnd-kit/sortable';

export interface UseRepoTodosOptions {
  repositoryId: string;
}

export interface UseRepoTodosReturn {
  categories: RepoTodoCategory[];
  todos: RepoTodo[];
  activeTodos: RepoTodo[];
  completedTodos: RepoTodo[];
  todosByCategory: Record<string, RepoTodo[]>;
  selectedTodoIds: Set<string>;
  selectedTodos: RepoTodo[];
  isLoading: boolean;
  error: string | null;
  loadData: () => Promise<void>;
  handleToggleSelect: (todoId: string) => void;
  handleToggleComplete: (todoId: string, isCompleted: boolean) => Promise<void>;
  handleDeleteTodo: (todoId: string) => Promise<void>;
  handleEditTodo: (todoId: string, content: string) => Promise<void>;
  handleConfirmAddTodo: (content: string, categoryId: string | null) => Promise<void>;
  handleEditCategory: (categoryId: string, name: string) => Promise<void>;
  handleDeleteCategory: (categoryId: string) => Promise<void>;
  handleAddCategory: (name: string) => Promise<RepoTodoCategory | null>;
  handleReorderTodos: (
    draggedId: string,
    overId: string,
    todosByCategory: Record<string, RepoTodo[]>
  ) => Promise<void>;
}

export function useRepoTodos({ repositoryId }: UseRepoTodosOptions): UseRepoTodosReturn {
  const [categories, setCategories] = useState<RepoTodoCategory[]>([]);
  const [todos, setTodos] = useState<RepoTodo[]>([]);
  const [selectedTodoIds, setSelectedTodoIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!repositoryId) return;
    setIsLoading(true);
    setError(null);
    try {
      const [fetchedCategories, fetchedTodos] = await Promise.all([
        getCategories(repositoryId),
        getTodos(repositoryId),
      ]);
      setCategories(fetchedCategories);
      setTodos(fetchedTodos);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load to-dos');
    } finally {
      setIsLoading(false);
    }
  }, [repositoryId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const { activeTodos, completedTodos, todosByCategory } = useMemo(() => {
    const active = todos.filter((t) => !t.isCompleted);
    const completed = todos.filter((t) => t.isCompleted);
    const byCategory: Record<string, RepoTodo[]> = { uncategorized: [] };

    categories.forEach((cat) => {
      byCategory[cat.categoryId] = [];
    });

    active.forEach((todo) => {
      const key = todo.categoryId || 'uncategorized';
      if (!byCategory[key]) byCategory[key] = [];
      byCategory[key].push(todo);
    });

    Object.keys(byCategory).forEach((key) => {
      byCategory[key].sort((a, b) => a.orderIndex - b.orderIndex);
    });

    return { activeTodos: active, completedTodos: completed, todosByCategory: byCategory };
  }, [todos, categories]);

  const selectedTodos = useMemo(
    () => activeTodos.filter((t) => selectedTodoIds.has(t.todoId)),
    [activeTodos, selectedTodoIds]
  );

  const handleToggleSelect = useCallback((todoId: string) => {
    setSelectedTodoIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(todoId)) newSet.delete(todoId);
      else newSet.add(todoId);
      return newSet;
    });
  }, []);

  const handleToggleComplete = useCallback(async (todoId: string, isCompleted: boolean) => {
    try {
      const updated = await updateTodo(todoId, { isCompleted });
      setTodos((prev) => prev.map((t) => (t.todoId === todoId ? updated : t)));
      if (isCompleted) {
        setSelectedTodoIds((prev) => {
          const newSet = new Set(prev);
          newSet.delete(todoId);
          return newSet;
        });
      }
    } catch (err) {
      console.error('Failed to update todo:', err);
    }
  }, []);

  const handleDeleteTodo = useCallback(async (todoId: string) => {
    try {
      await deleteTodo(todoId);
      setTodos((prev) => prev.filter((t) => t.todoId !== todoId));
      setSelectedTodoIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(todoId);
        return newSet;
      });
    } catch (err) {
      console.error('Failed to delete todo:', err);
    }
  }, []);

  const handleEditTodo = useCallback(async (todoId: string, content: string) => {
    try {
      const updated = await updateTodo(todoId, { content });
      setTodos((prev) => prev.map((t) => (t.todoId === todoId ? updated : t)));
    } catch (err) {
      console.error('Failed to update todo:', err);
    }
  }, []);

  const handleConfirmAddTodo = useCallback(async (content: string, categoryId: string | null) => {
    try {
      const newTodo = await createTodo({ repository: repositoryId, categoryId, content });
      setTodos((prev) => [...prev, newTodo]);
    } catch (err) {
      console.error('Failed to create todo:', err);
    }
  }, [repositoryId]);

  const handleEditCategory = useCallback(async (categoryId: string, name: string) => {
    try {
      const updated = await updateCategory(categoryId, { name });
      setCategories((prev) => prev.map((c) => (c.categoryId === categoryId ? updated : c)));
    } catch (err) {
      console.error('Failed to update category:', err);
    }
  }, []);

  const handleDeleteCategory = useCallback(async (categoryId: string) => {
    try {
      await deleteCategory(categoryId);
      setCategories((prev) => prev.filter((c) => c.categoryId !== categoryId));
      setTodos((prev) =>
        prev.map((t) => (t.categoryId === categoryId ? { ...t, categoryId: null } : t))
      );
    } catch (err) {
      console.error('Failed to delete category:', err);
    }
  }, []);

  const handleAddCategory = useCallback(async (name: string): Promise<RepoTodoCategory | null> => {
    if (!name.trim()) return null;
    try {
      const newCategory = await createCategory({ repository: repositoryId, name: name.trim() });
      setCategories((prev) => [...prev, newCategory]);
      return newCategory;
    } catch (err) {
      console.error('Failed to create category:', err);
      return null;
    }
  }, [repositoryId]);

  const handleReorderTodos = useCallback(async (
    draggedId: string,
    overId: string,
    currentTodosByCategory: Record<string, RepoTodo[]>
  ) => {
    const activeTodo = todos.find((t) => t.todoId === draggedId);
    const overTodo = todos.find((t) => t.todoId === overId);

    if (!activeTodo || !overTodo) return;

    const activeCategoryId = activeTodo.categoryId || 'uncategorized';
    const overCategoryId = overTodo.categoryId || 'uncategorized';

    if (activeCategoryId === overCategoryId) {
      const categoryTodos = currentTodosByCategory[activeCategoryId] || [];
      const oldIndex = categoryTodos.findIndex((t) => t.todoId === draggedId);
      const newIndex = categoryTodos.findIndex((t) => t.todoId === overId);

      if (oldIndex !== -1 && newIndex !== -1) {
        const reordered = arrayMove(categoryTodos, oldIndex, newIndex);
        const reorderItems: BatchReorderItem[] = reordered.map((todo, index) => ({
          id: todo.todoId,
          orderIndex: index,
        }));

        setTodos((prev) => {
          const otherTodos = prev.filter((t) => (t.categoryId || 'uncategorized') !== activeCategoryId);
          const updatedTodos = reordered.map((todo, index) => ({ ...todo, orderIndex: index }));
          return [...otherTodos, ...updatedTodos];
        });

        try {
          await reorderTodos({ repository: repositoryId, items: reorderItems });
        } catch (err) {
          console.error('Failed to reorder todos:', err);
          loadData();
        }
      }
    } else {
      const newCategoryId = overTodo.categoryId;
      const targetCategoryTodos = [...(currentTodosByCategory[overCategoryId] || [])];
      const insertIndex = targetCategoryTodos.findIndex((t) => t.todoId === overId);
      const movedTodo = { ...activeTodo, categoryId: newCategoryId, orderIndex: insertIndex };

      const reorderItems: BatchReorderItem[] = [];
      targetCategoryTodos.splice(insertIndex, 0, movedTodo);
      targetCategoryTodos.forEach((todo, index) => {
        reorderItems.push({ id: todo.todoId, orderIndex: index, categoryId: newCategoryId });
      });

      setTodos((prev) => prev.map((t) => (t.todoId === draggedId ? movedTodo : t)));

      try {
        await reorderTodos({ repository: repositoryId, items: reorderItems });
      } catch (err) {
        console.error('Failed to move todo:', err);
        loadData();
      }
    }
  }, [todos, repositoryId, loadData]);

  return {
    categories,
    todos,
    activeTodos,
    completedTodos,
    todosByCategory,
    selectedTodoIds,
    selectedTodos,
    isLoading,
    error,
    loadData,
    handleToggleSelect,
    handleToggleComplete,
    handleDeleteTodo,
    handleEditTodo,
    handleConfirmAddTodo,
    handleEditCategory,
    handleDeleteCategory,
    handleAddCategory,
    handleReorderTodos,
  };
}
