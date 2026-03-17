import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ListTodo,
  Plus,
  GripVertical,
  Check,
  Trash2,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Sparkles,
  X,
  Edit3,
} from 'lucide-react';
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
} from '../../api/repoTodosApi';

export interface RepoTodosPanelProps {
  repositoryName: string;
  repositoryId: string;
  disabled?: boolean;
}

// ============================================================================
// Sortable Todo Item Component
// ============================================================================

interface SortableTodoItemProps {
  todo: RepoTodo;
  isSelected: boolean;
  onToggleSelect: (todoId: string) => void;
  onToggleComplete: (todoId: string, isCompleted: boolean) => void;
  onDelete: (todoId: string) => void;
  onEdit: (todoId: string, content: string) => void;
  disabled?: boolean;
}

const SortableTodoItem: React.FC<SortableTodoItemProps> = ({
  todo,
  isSelected,
  onToggleSelect,
  onToggleComplete,
  onDelete,
  onEdit,
  disabled,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(todo.content);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: todo.todoId, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleSaveEdit = () => {
    if (editContent.trim() && editContent !== todo.content) {
      onEdit(todo.todoId, editContent.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      setEditContent(todo.content);
      setIsEditing(false);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-start gap-2 p-2.5 rounded-lg border transition-all
        ${isDragging ? 'opacity-50 bg-slate-100 shadow-lg z-50' : 'bg-white border-slate-200'}
        ${isSelected && !todo.isCompleted ? 'ring-2 ring-teal-500 border-teal-300' : ''}
        ${todo.isCompleted ? 'opacity-60' : ''}
        ${disabled ? 'cursor-not-allowed' : ''}
      `}
    >
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        className={`flex-shrink-0 mt-0.5 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 transition-colors
          ${disabled ? 'pointer-events-none' : ''}
        `}
      >
        <GripVertical size={14} />
      </div>

      {/* Selection checkbox (only for non-completed items) */}
      {!todo.isCompleted && (
        <button
          onClick={() => onToggleSelect(todo.todoId)}
          disabled={disabled}
          className={`flex-shrink-0 w-4 h-4 mt-0.5 rounded border transition-all
            ${isSelected
              ? 'bg-teal-500 border-teal-500 text-white'
              : 'border-slate-300 hover:border-teal-400'
            }
            ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
          `}
        >
          {isSelected && <Check size={12} className="m-auto" />}
        </button>
      )}

      {/* Completion checkbox */}
      <button
        onClick={() => onToggleComplete(todo.todoId, !todo.isCompleted)}
        disabled={disabled}
        className={`flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-2 transition-all
          ${todo.isCompleted
            ? 'bg-green-500 border-green-500 text-white'
            : 'border-slate-300 hover:border-green-400'
          }
          ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        {todo.isCompleted && <Check size={10} className="m-auto" />}
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onBlur={handleSaveEdit}
            onKeyDown={handleKeyDown}
            autoFocus
            className="w-full px-2 py-1 text-sm border border-teal-300 rounded focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
            rows={2}
          />
        ) : (
          <p
            className={`text-sm leading-relaxed break-words
              ${todo.isCompleted ? 'line-through text-slate-400' : 'text-slate-700'}
            `}
          >
            {todo.content}
          </p>
        )}
        {todo.linkedDraftId && (
          <span className="inline-flex items-center gap-1 mt-1 text-[10px] text-teal-600 bg-teal-50 px-1.5 py-0.5 rounded">
            <Sparkles size={10} />
            Linked to plan
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!isEditing && !todo.isCompleted && (
          <button
            onClick={() => setIsEditing(true)}
            disabled={disabled}
            className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
            title="Edit"
          >
            <Edit3 size={12} />
          </button>
        )}
        <button
          onClick={() => onDelete(todo.todoId)}
          disabled={disabled}
          className="p-1 text-slate-400 hover:text-red-500 transition-colors"
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// Todo Item Overlay (for drag preview)
// ============================================================================

const TodoItemOverlay: React.FC<{ todo: RepoTodo }> = ({ todo }) => (
  <div className="flex items-start gap-2 p-2.5 rounded-lg border bg-white border-teal-300 shadow-lg">
    <div className="flex-shrink-0 mt-0.5 text-slate-400">
      <GripVertical size={14} />
    </div>
    <div className="flex-shrink-0 w-4 h-4 mt-0.5 rounded border border-slate-300" />
    <div className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-2 border-slate-300" />
    <p className="flex-1 text-sm text-slate-700 break-words">{todo.content}</p>
  </div>
);

// ============================================================================
// Category Section Component
// ============================================================================

interface CategorySectionProps {
  category: RepoTodoCategory | null;
  todos: RepoTodo[];
  selectedTodoIds: Set<string>;
  onToggleSelect: (todoId: string) => void;
  onToggleComplete: (todoId: string, isCompleted: boolean) => void;
  onDeleteTodo: (todoId: string) => void;
  onEditTodo: (todoId: string, content: string) => void;
  onAddTodo: (categoryId: string | null) => void;
  onEditCategory?: (categoryId: string, name: string) => void;
  onDeleteCategory?: (categoryId: string) => void;
  disabled?: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

const CategorySection: React.FC<CategorySectionProps> = ({
  category,
  todos,
  selectedTodoIds,
  onToggleSelect,
  onToggleComplete,
  onDeleteTodo,
  onEditTodo,
  onAddTodo,
  onEditCategory,
  onDeleteCategory,
  disabled,
  isExpanded,
  onToggleExpand,
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(category?.name || '');
  const categoryId = category?.categoryId || null;
  const categoryName = category?.name || 'Uncategorized';
  const todoIds = todos.map((t) => t.todoId);

  const handleSaveName = () => {
    if (category && editName.trim() && editName !== category.name && onEditCategory) {
      onEditCategory(category.categoryId, editName.trim());
    }
    setIsEditingName(false);
  };

  return (
    <div className="mb-4">
      {/* Category Header */}
      <div className="group flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-slate-100 transition-colors">
        <button
          onClick={onToggleExpand}
          className="flex-shrink-0 text-slate-400 hover:text-slate-600"
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-shrink-0 text-slate-400">
          {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        </div>
        {isEditingName && category ? (
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleSaveName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveName();
              if (e.key === 'Escape') {
                setEditName(category.name);
                setIsEditingName(false);
              }
            }}
            autoFocus
            className="flex-1 px-1 text-xs font-semibold text-slate-700 border border-teal-300 rounded focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
        ) : (
          <span
            className="flex-1 text-xs font-semibold text-slate-600 uppercase tracking-wider cursor-pointer"
            onClick={() => category && setIsEditingName(true)}
          >
            {categoryName}
          </span>
        )}
        <span className="text-[10px] text-slate-400">{todos.length}</span>
        {category && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => setIsEditingName(true)}
              className="p-0.5 text-slate-400 hover:text-slate-600"
              title="Edit category name"
            >
              <Edit3 size={10} />
            </button>
            <button
              onClick={() => onDeleteCategory?.(category.categoryId)}
              className="p-0.5 text-slate-400 hover:text-red-500"
              title="Delete category"
            >
              <Trash2 size={10} />
            </button>
          </div>
        )}
        <button
          onClick={() => onAddTodo(categoryId)}
          disabled={disabled}
          className="p-0.5 text-slate-400 hover:text-teal-600"
          title="Add to-do"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Todos */}
      {isExpanded && (
        <div className="ml-4 mt-1 space-y-1.5">
          <SortableContext items={todoIds} strategy={verticalListSortingStrategy}>
            {todos.map((todo) => (
              <SortableTodoItem
                key={todo.todoId}
                todo={todo}
                isSelected={selectedTodoIds.has(todo.todoId)}
                onToggleSelect={onToggleSelect}
                onToggleComplete={onToggleComplete}
                onDelete={onDeleteTodo}
                onEdit={onEditTodo}
                disabled={disabled}
              />
            ))}
          </SortableContext>
          {todos.length === 0 && (
            <p className="text-xs text-slate-400 italic py-2 px-2">No items in this category</p>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Completed Items Accordion
// ============================================================================

interface CompletedItemsAccordionProps {
  todos: RepoTodo[];
  onToggleComplete: (todoId: string, isCompleted: boolean) => void;
  onDeleteTodo: (todoId: string) => void;
  disabled?: boolean;
}

const CompletedItemsAccordion: React.FC<CompletedItemsAccordionProps> = ({
  todos,
  onToggleComplete,
  onDeleteTodo,
  disabled,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (todos.length === 0) return null;

  return (
    <div className="mt-6 pt-4 border-t border-slate-200">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded-md hover:bg-slate-100 transition-colors"
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Check size={14} className="text-green-500" />
        <span className="flex-1 text-xs font-semibold text-slate-500 uppercase tracking-wider">
          Completed Items
        </span>
        <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
          {todos.length}
        </span>
      </button>

      {isExpanded && (
        <div className="mt-2 space-y-1.5 ml-4">
          {todos.map((todo) => (
            <div
              key={todo.todoId}
              className="group flex items-start gap-2 p-2.5 rounded-lg border bg-slate-50 border-slate-200 opacity-60"
            >
              <button
                onClick={() => onToggleComplete(todo.todoId, false)}
                disabled={disabled}
                className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-2 bg-green-500 border-green-500 text-white cursor-pointer"
                title="Mark as incomplete"
              >
                <Check size={10} className="m-auto" />
              </button>
              <p className="flex-1 text-sm text-slate-400 line-through break-words">
                {todo.content}
              </p>
              <button
                onClick={() => onDeleteTodo(todo.todoId)}
                disabled={disabled}
                className="flex-shrink-0 p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Add Todo Input Component
// ============================================================================

interface AddTodoInputProps {
  categoryId: string | null;
  onAdd: (content: string) => void;
  onCancel: () => void;
}

const AddTodoInput: React.FC<AddTodoInputProps> = ({ onAdd, onCancel }) => {
  const [content, setContent] = useState('');

  const handleSubmit = () => {
    if (content.trim()) {
      onAdd(content.trim());
      setContent('');
    }
  };

  return (
    <div className="flex items-start gap-2 p-2.5 rounded-lg border border-teal-300 bg-teal-50">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="What needs to be done?"
        autoFocus
        className="flex-1 px-2 py-1 text-sm border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none bg-white"
        rows={2}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
          if (e.key === 'Escape') {
            onCancel();
          }
        }}
      />
      <div className="flex flex-col gap-1">
        <button
          onClick={handleSubmit}
          disabled={!content.trim()}
          className="p-1.5 bg-teal-500 text-white rounded hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Add"
        >
          <Check size={14} />
        </button>
        <button
          onClick={onCancel}
          className="p-1.5 bg-slate-200 text-slate-600 rounded hover:bg-slate-300 transition-colors"
          title="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// Main Panel Component
// ============================================================================

const RepoTodosPanel: React.FC<RepoTodosPanelProps> = ({
  repositoryName,
  repositoryId,
  disabled = false,
}) => {
  const navigate = useNavigate();
  const [categories, setCategories] = useState<RepoTodoCategory[]>([]);
  const [todos, setTodos] = useState<RepoTodo[]>([]);
  const [selectedTodoIds, setSelectedTodoIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['uncategorized']));
  const [addingToCategory, setAddingToCategory] = useState<string | null | false>(false);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Load data
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
      // Expand all categories by default
      const categoryIds = new Set(['uncategorized', ...fetchedCategories.map((c) => c.categoryId)]);
      setExpandedCategories(categoryIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load to-dos');
    } finally {
      setIsLoading(false);
    }
  }, [repositoryId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Organize todos by category
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

    // Sort by orderIndex
    Object.keys(byCategory).forEach((key) => {
      byCategory[key].sort((a, b) => a.orderIndex - b.orderIndex);
    });

    return { activeTodos: active, completedTodos: completed, todosByCategory: byCategory };
  }, [todos, categories]);

  // Get selected (non-completed) todos
  const selectedTodos = useMemo(
    () => activeTodos.filter((t) => selectedTodoIds.has(t.todoId)),
    [activeTodos, selectedTodoIds]
  );

  // Handlers
  const handleToggleSelect = useCallback((todoId: string) => {
    setSelectedTodoIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(todoId)) {
        newSet.delete(todoId);
      } else {
        newSet.add(todoId);
      }
      return newSet;
    });
  }, []);

  const handleToggleComplete = useCallback(async (todoId: string, isCompleted: boolean) => {
    try {
      const updated = await updateTodo(todoId, { isCompleted });
      setTodos((prev) => prev.map((t) => (t.todoId === todoId ? updated : t)));
      // Remove from selection if completed
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

  const handleAddTodo = useCallback((categoryId: string | null) => {
    setAddingToCategory(categoryId);
  }, []);

  const handleConfirmAddTodo = useCallback(async (content: string) => {
    const categoryId = addingToCategory === false ? null : addingToCategory;
    try {
      const newTodo = await createTodo({
        repository: repositoryId,
        categoryId,
        content,
      });
      setTodos((prev) => [...prev, newTodo]);
      setAddingToCategory(false);
    } catch (err) {
      console.error('Failed to create todo:', err);
    }
  }, [addingToCategory, repositoryId]);

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
      // Todos are moved to uncategorized on the backend
      setTodos((prev) =>
        prev.map((t) => (t.categoryId === categoryId ? { ...t, categoryId: null } : t))
      );
    } catch (err) {
      console.error('Failed to delete category:', err);
    }
  }, []);

  const handleAddCategory = useCallback(async () => {
    if (!newCategoryName.trim()) return;
    try {
      const newCategory = await createCategory({
        repository: repositoryId,
        name: newCategoryName.trim(),
      });
      setCategories((prev) => [...prev, newCategory]);
      setExpandedCategories((prev) => new Set([...prev, newCategory.categoryId]));
      setNewCategoryName('');
      setIsAddingCategory(false);
    } catch (err) {
      console.error('Failed to create category:', err);
    }
  }, [newCategoryName, repositoryId]);

  const handleToggleCategoryExpand = useCallback((categoryId: string) => {
    setExpandedCategories((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(categoryId)) {
        newSet.delete(categoryId);
      } else {
        newSet.add(categoryId);
      }
      return newSet;
    });
  }, []);

  // Drag handlers
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    // Find the todos involved
    const activeTodo = todos.find((t) => t.todoId === activeId);
    const overTodo = todos.find((t) => t.todoId === overId);

    if (!activeTodo || !overTodo) return;

    // Check if moving within same category or between categories
    const activeCategoryId = activeTodo.categoryId || 'uncategorized';
    const overCategoryId = overTodo.categoryId || 'uncategorized';

    if (activeCategoryId === overCategoryId) {
      // Same category - reorder
      const categoryTodos = todosByCategory[activeCategoryId] || [];
      const oldIndex = categoryTodos.findIndex((t) => t.todoId === activeId);
      const newIndex = categoryTodos.findIndex((t) => t.todoId === overId);

      if (oldIndex !== -1 && newIndex !== -1) {
        const reordered = arrayMove(categoryTodos, oldIndex, newIndex);
        const reorderItems: BatchReorderItem[] = reordered.map((todo, index) => ({
          id: todo.todoId,
          orderIndex: index,
        }));

        // Optimistic update
        setTodos((prev) => {
          const otherTodos = prev.filter(
            (t) => (t.categoryId || 'uncategorized') !== activeCategoryId
          );
          const updatedTodos = reordered.map((todo, index) => ({
            ...todo,
            orderIndex: index,
          }));
          return [...otherTodos, ...updatedTodos];
        });

        try {
          await reorderTodos({ repository: repositoryId, items: reorderItems });
        } catch (err) {
          console.error('Failed to reorder todos:', err);
          loadData(); // Reload on error
        }
      }
    } else {
      // Moving between categories
      const newCategoryId = overTodo.categoryId;
      const targetCategoryTodos = [...(todosByCategory[overCategoryId] || [])];
      const insertIndex = targetCategoryTodos.findIndex((t) => t.todoId === overId);

      // Update the moved todo
      const movedTodo = { ...activeTodo, categoryId: newCategoryId, orderIndex: insertIndex };

      // Create reorder items for the target category
      const reorderItems: BatchReorderItem[] = [];
      targetCategoryTodos.splice(insertIndex, 0, movedTodo);
      targetCategoryTodos.forEach((todo, index) => {
        reorderItems.push({
          id: todo.todoId,
          orderIndex: index,
          categoryId: newCategoryId,
        });
      });

      // Optimistic update
      setTodos((prev) => prev.map((t) => (t.todoId === activeId ? movedTodo : t)));

      try {
        await reorderTodos({ repository: repositoryId, items: reorderItems });
      } catch (err) {
        console.error('Failed to move todo:', err);
        loadData(); // Reload on error
      }
    }
  };

  // Create Plan handler
  const handleCreatePlan = useCallback(() => {
    const prompt = selectedTodos
      .map((todo, index) => `${index + 1}. ${todo.content}`)
      .join('\n');

    const todoIds = selectedTodos.map((t) => t.todoId);

    navigate('/studio/new', {
      state: {
        initialPrompt: prompt,
        initialRepository: repositoryId,
        todoIds,
      },
    });
  }, [selectedTodos, navigate, repositoryId]);

  // Get the active todo for drag overlay
  const activeTodo = activeId ? todos.find((t) => t.todoId === activeId) : null;

  // Loading state
  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="animate-spin h-6 w-6 border-2 border-teal-500 border-t-transparent rounded-full mx-auto mb-2" />
          <p className="text-sm text-slate-500">Loading to-dos...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50 p-4">
        <div className="text-center">
          <p className="text-sm text-red-500 mb-2">{error}</p>
          <button
            onClick={loadData}
            className="text-sm text-teal-600 hover:text-teal-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <ListTodo size={16} className="text-indigo-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">To-Dos</h3>
            <p className="text-xs text-slate-500">
              {activeTodos.length} item{activeTodos.length !== 1 ? 's' : ''}
              {completedTodos.length > 0 && ` • ${completedTodos.length} completed`}
            </p>
          </div>
          <button
            onClick={() => setIsAddingCategory(true)}
            disabled={disabled}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 hover:text-teal-600 hover:bg-slate-100 rounded transition-colors"
          >
            <Folder size={12} />
            <Plus size={10} />
          </button>
          <button
            onClick={() => handleAddTodo(null)}
            disabled={disabled}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-teal-500 text-white rounded hover:bg-teal-600 transition-colors"
          >
            <Plus size={12} />
            <span>Add</span>
          </button>
        </div>

        {/* Add Category Input */}
        {isAddingCategory && (
          <div className="mt-3 flex items-center gap-2">
            <Folder size={14} className="text-slate-400" />
            <input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="Category name..."
              autoFocus
              className="flex-1 px-2 py-1 text-sm border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-teal-500"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddCategory();
                if (e.key === 'Escape') {
                  setIsAddingCategory(false);
                  setNewCategoryName('');
                }
              }}
            />
            <button
              onClick={handleAddCategory}
              disabled={!newCategoryName.trim()}
              className="p-1 bg-teal-500 text-white rounded hover:bg-teal-600 disabled:opacity-50 transition-colors"
            >
              <Check size={14} />
            </button>
            <button
              onClick={() => {
                setIsAddingCategory(false);
                setNewCategoryName('');
              }}
              className="p-1 bg-slate-200 text-slate-600 rounded hover:bg-slate-300 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div
        className="flex-1 overflow-y-auto px-4 py-4"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#d1d5db transparent' }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {/* Add Todo Input (if adding to top-level) */}
          {addingToCategory === null && (
            <div className="mb-4">
              <AddTodoInput
                categoryId={null}
                onAdd={handleConfirmAddTodo}
                onCancel={() => setAddingToCategory(false)}
              />
            </div>
          )}

          {/* Categories */}
          {categories.map((category) => (
            <React.Fragment key={category.categoryId}>
              {addingToCategory === category.categoryId && (
                <div className="mb-2 ml-4">
                  <AddTodoInput
                    categoryId={category.categoryId}
                    onAdd={handleConfirmAddTodo}
                    onCancel={() => setAddingToCategory(false)}
                  />
                </div>
              )}
              <CategorySection
                category={category}
                todos={todosByCategory[category.categoryId] || []}
                selectedTodoIds={selectedTodoIds}
                onToggleSelect={handleToggleSelect}
                onToggleComplete={handleToggleComplete}
                onDeleteTodo={handleDeleteTodo}
                onEditTodo={handleEditTodo}
                onAddTodo={handleAddTodo}
                onEditCategory={handleEditCategory}
                onDeleteCategory={handleDeleteCategory}
                disabled={disabled}
                isExpanded={expandedCategories.has(category.categoryId)}
                onToggleExpand={() => handleToggleCategoryExpand(category.categoryId)}
              />
            </React.Fragment>
          ))}

          {/* Uncategorized Section */}
          <CategorySection
            category={null}
            todos={todosByCategory['uncategorized'] || []}
            selectedTodoIds={selectedTodoIds}
            onToggleSelect={handleToggleSelect}
            onToggleComplete={handleToggleComplete}
            onDeleteTodo={handleDeleteTodo}
            onEditTodo={handleEditTodo}
            onAddTodo={handleAddTodo}
            disabled={disabled}
            isExpanded={expandedCategories.has('uncategorized')}
            onToggleExpand={() => handleToggleCategoryExpand('uncategorized')}
          />

          {/* Drag Overlay */}
          <DragOverlay>
            {activeTodo ? <TodoItemOverlay todo={activeTodo} /> : null}
          </DragOverlay>
        </DndContext>

        {/* Completed Items Accordion */}
        <CompletedItemsAccordion
          todos={completedTodos}
          onToggleComplete={handleToggleComplete}
          onDeleteTodo={handleDeleteTodo}
          disabled={disabled}
        />

        {/* Empty State */}
        {activeTodos.length === 0 && completedTodos.length === 0 && (
          <div className="text-center py-12">
            <ListTodo size={32} className="mx-auto text-slate-300 mb-3" />
            <p className="text-sm text-slate-500 mb-1">No to-dos yet</p>
            <p className="text-xs text-slate-400">
              Add ideas, tasks, or notes to keep track of what needs to be done
            </p>
          </div>
        )}
      </div>

      {/* Footer - Create Plan Button */}
      {selectedTodos.length > 0 && (
        <div className="flex-shrink-0 p-4 border-t border-slate-200 bg-white">
          <button
            onClick={handleCreatePlan}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Sparkles size={16} />
            <span className="font-medium">
              Create Plan from {selectedTodos.length} Item{selectedTodos.length !== 1 ? 's' : ''}
            </span>
          </button>
        </div>
      )}
    </div>
  );
};

export default RepoTodosPanel;
