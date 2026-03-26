import React, { useState, useCallback, useEffect, useMemo } from 'react';
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
  pointerWithin,
  rectIntersection,
} from '@dnd-kit/core';
import {
  sortableKeyboardCoordinates,
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ListTodo, Plus, Check, Folder, X, Sparkles, Search } from 'lucide-react';
import {
  TodoItemOverlay,
  CategorySection,
  CompletedItemsAccordion,
  useRepoTodos,
} from './RepoTodos';

export interface RepoTodosPanelProps {
  repositoryName: string;
  repositoryId: string;
  disabled?: boolean;
}

const RepoTodosPanel: React.FC<RepoTodosPanelProps> = ({ repositoryId, disabled = false }) => {
  const navigate = useNavigate();
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['uncategorized']));
  const [addingToCategory, setAddingToCategory] = useState<string | null | false>(false);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const {
    categories, todos, activeTodos, completedTodos, todosByCategory,
    selectedTodoIds, selectedTodos, isLoading, error, loadData,
    handleToggleSelect, handleToggleComplete, handleDeleteTodo, handleEditTodo,
    handleConfirmAddTodo, handleEditCategory, handleDeleteCategory, handleAddCategory,
    handleReorderTodos, handleReorderCategories, handleMoveTodoToCategory,
  } = useRepoTodos({ repositoryId });

  // Filter todos based on search query
  const filteredTodosByCategory = useMemo(() => {
    if (!searchQuery.trim()) return todosByCategory;

    const query = searchQuery.toLowerCase();
    const filtered: typeof todosByCategory = {};

    for (const [categoryId, todos] of Object.entries(todosByCategory)) {
      const matchingTodos = todos.filter(todo =>
        todo.content.toLowerCase().includes(query)
      );
      if (matchingTodos.length > 0) {
        filtered[categoryId] = matchingTodos;
      }
    }

    return filtered;
  }, [todosByCategory, searchQuery]);

  const filteredCompletedTodos = useMemo(() => {
    if (!searchQuery.trim()) return completedTodos;

    const query = searchQuery.toLowerCase();
    return completedTodos.filter(todo =>
      todo.content.toLowerCase().includes(query)
    );
  }, [completedTodos, searchQuery]);

  // Auto-expand categories that contain matching results when searching
  useEffect(() => {
    if (searchQuery.trim()) {
      const matchingCategoryIds = Object.keys(filteredTodosByCategory);
      if (matchingCategoryIds.length > 0) {
        setExpandedCategories(prev => {
          const newSet = new Set(prev);
          matchingCategoryIds.forEach(id => newSet.add(id));
          return newSet;
        });
      }
    }
  }, [searchQuery, filteredTodosByCategory]);

  useEffect(() => {
    const categoryIds = new Set(['uncategorized', ...categories.map((c) => c.categoryId)]);
    setExpandedCategories(categoryIds);
  }, [categories]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleAddTodo = useCallback((categoryId: string | null) => {
    setAddingToCategory(categoryId);
    // Auto-expand the category when adding a todo
    const expandKey = categoryId || 'uncategorized';
    setExpandedCategories((prev) => {
      if (prev.has(expandKey)) return prev;
      return new Set([...prev, expandKey]);
    });
  }, []);

  const onConfirmAddTodo = useCallback(async (content: string) => {
    const categoryId = addingToCategory === false ? null : addingToCategory;
    await handleConfirmAddTodo(content, categoryId);
    setAddingToCategory(false);
  }, [addingToCategory, handleConfirmAddTodo]);

  const onAddCategory = useCallback(async () => {
    const newCategory = await handleAddCategory(newCategoryName);
    if (newCategory) {
      setExpandedCategories((prev) => new Set([...prev, newCategory.categoryId]));
      setNewCategoryName('');
      setIsAddingCategory(false);
    }
  }, [newCategoryName, handleAddCategory]);

  const handleToggleCategoryExpand = useCallback((categoryId: string) => {
    setExpandedCategories((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(categoryId)) newSet.delete(categoryId);
      else newSet.add(categoryId);
      return newSet;
    });
  }, []);

  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;

    const activeIdStr = active.id as string;
    const overIdStr = over.id as string;

    // Check if we're reordering categories
    const isActiveCategory = categories.some(c => c.categoryId === activeIdStr);
    const isOverCategory = categories.some(c => c.categoryId === overIdStr);

    if (isActiveCategory && isOverCategory) {
      // Reordering categories
      await handleReorderCategories(activeIdStr, overIdStr);
      return;
    }

    // Check if dropping on a category drop zone (for empty categories)
    if (overIdStr.startsWith('category-drop-')) {
      const targetCategoryId = overIdStr.replace('category-drop-', '');
      const newCategoryId = targetCategoryId === 'uncategorized' ? null : targetCategoryId;
      await handleMoveTodoToCategory(activeIdStr, newCategoryId);
      return;
    }

    // Otherwise, standard todo reordering
    await handleReorderTodos(activeIdStr, overIdStr, todosByCategory);
  };

  // Custom collision detection that prefers droppable areas when no todo items overlap
  const collisionDetectionStrategy = useCallback((args: Parameters<typeof closestCenter>[0]) => {
    // First try to find intersecting todos
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      // Filter out category droppables if we have todo collisions
      const todoCollisions = pointerCollisions.filter(
        collision => !String(collision.id).startsWith('category-drop-')
      );
      if (todoCollisions.length > 0) {
        return todoCollisions;
      }
    }

    // Fall back to rect intersection for category drop zones
    const rectCollisions = rectIntersection(args);
    if (rectCollisions.length > 0) {
      return rectCollisions;
    }

    // Default to closest center
    return closestCenter(args);
  }, []);

  const categoryIds = categories.map(c => c.categoryId);

  const handleCreatePlan = useCallback(() => {
    const prompt = selectedTodos.map((todo, index) => `${index + 1}. ${todo.content}`).join('\n');
    const todoIds = selectedTodos.map((t) => t.todoId);
    navigate('/studio/new', { state: { initialPrompt: prompt, initialRepository: repositoryId, todoIds } });
  }, [selectedTodos, navigate, repositoryId]);

  const activeTodo = activeId ? todos.find((t) => t.todoId === activeId) : null;

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

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50 p-4">
        <div className="text-center">
          <p className="text-sm text-red-500 mb-2">{error}</p>
          <button onClick={loadData} className="text-sm text-teal-600 hover:text-teal-700">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-50">
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
            <Folder size={12} /><Plus size={10} />
          </button>
          <button
            onClick={() => handleAddTodo(null)}
            disabled={disabled}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-teal-500 text-white rounded hover:bg-teal-600 transition-colors"
          >
            <Plus size={12} /><span>Add</span>
          </button>
        </div>
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
                if (e.key === 'Enter') onAddCategory();
                if (e.key === 'Escape') { setIsAddingCategory(false); setNewCategoryName(''); }
              }}
            />
            <button onClick={onAddCategory} disabled={!newCategoryName.trim()} className="p-1 bg-teal-500 text-white rounded hover:bg-teal-600 disabled:opacity-50 transition-colors">
              <Check size={14} />
            </button>
            <button onClick={() => { setIsAddingCategory(false); setNewCategoryName(''); }} className="p-1 bg-slate-200 text-slate-600 rounded hover:bg-slate-300 transition-colors">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="mt-3 relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search to-dos..."
            className="w-full pl-8 pr-8 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4" style={{ scrollbarWidth: 'thin', scrollbarColor: '#d1d5db transparent' }}>
        <DndContext sensors={sensors} collisionDetection={collisionDetectionStrategy} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <SortableContext items={categoryIds} strategy={verticalListSortingStrategy}>
            {categories.map((category) => {
              const categoryTodos = filteredTodosByCategory[category.categoryId] || [];
              // Hide empty categories when searching
              if (searchQuery.trim() && categoryTodos.length === 0) return null;
              return (
                <CategorySection
                  key={category.categoryId}
                  category={category}
                  todos={categoryTodos}
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
                  isSortable={true}
                  isAddingTodo={addingToCategory === category.categoryId}
                  onConfirmAddTodo={onConfirmAddTodo}
                  onCancelAddTodo={() => setAddingToCategory(false)}
                />
              );
            })}
          </SortableContext>
          {(!searchQuery.trim() || (filteredTodosByCategory['uncategorized']?.length ?? 0) > 0) && (
            <CategorySection
              category={null}
              todos={filteredTodosByCategory['uncategorized'] || []}
              selectedTodoIds={selectedTodoIds}
              onToggleSelect={handleToggleSelect}
              onToggleComplete={handleToggleComplete}
              onDeleteTodo={handleDeleteTodo}
              onEditTodo={handleEditTodo}
              onAddTodo={handleAddTodo}
              disabled={disabled}
              isExpanded={expandedCategories.has('uncategorized')}
              onToggleExpand={() => handleToggleCategoryExpand('uncategorized')}
              isAddingTodo={addingToCategory === null}
              onConfirmAddTodo={onConfirmAddTodo}
              onCancelAddTodo={() => setAddingToCategory(false)}
            />
          )}
          <DragOverlay>{activeTodo ? <TodoItemOverlay todo={activeTodo} /> : null}</DragOverlay>
        </DndContext>
        <CompletedItemsAccordion
          todos={filteredCompletedTodos}
          onToggleComplete={handleToggleComplete}
          onDeleteTodo={handleDeleteTodo}
          disabled={disabled}
          forceExpand={searchQuery.trim() !== '' && filteredCompletedTodos.length > 0}
        />
        {activeTodos.length === 0 && completedTodos.length === 0 && (
          <div className="text-center py-12">
            <ListTodo size={32} className="mx-auto text-slate-300 mb-3" />
            <p className="text-sm text-slate-500 mb-1">No to-dos yet</p>
            <p className="text-xs text-slate-400">Add ideas, tasks, or notes to keep track of what needs to be done</p>
          </div>
        )}
      </div>

      {selectedTodos.length > 0 && (
        <div className="flex-shrink-0 p-4 border-t border-slate-200 bg-white">
          <button onClick={handleCreatePlan} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-sm">
            <Sparkles size={16} />
            <span className="font-medium">Create Plan from {selectedTodos.length} Item{selectedTodos.length !== 1 ? 's' : ''}</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default RepoTodosPanel;
