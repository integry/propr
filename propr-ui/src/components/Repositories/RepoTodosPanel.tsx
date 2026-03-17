import React, { useState, useCallback, useEffect } from 'react';
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
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { ListTodo, Plus, Check, Folder, X, Sparkles } from 'lucide-react';
import {
  TodoItemOverlay,
  CategorySection,
  CompletedItemsAccordion,
  AddTodoInput,
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

  const {
    categories, todos, activeTodos, completedTodos, todosByCategory,
    selectedTodoIds, selectedTodos, isLoading, error, loadData,
    handleToggleSelect, handleToggleComplete, handleDeleteTodo, handleEditTodo,
    handleConfirmAddTodo, handleEditCategory, handleDeleteCategory, handleAddCategory,
    handleReorderTodos,
  } = useRepoTodos({ repositoryId });

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
    await handleReorderTodos(active.id as string, over.id as string, todosByCategory);
  };

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
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4" style={{ scrollbarWidth: 'thin', scrollbarColor: '#d1d5db transparent' }}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          {addingToCategory === null && (
            <div className="mb-4">
              <AddTodoInput categoryId={null} onAdd={onConfirmAddTodo} onCancel={() => setAddingToCategory(false)} />
            </div>
          )}
          {categories.map((category) => (
            <React.Fragment key={category.categoryId}>
              {addingToCategory === category.categoryId && (
                <div className="mb-2 ml-4">
                  <AddTodoInput categoryId={category.categoryId} onAdd={onConfirmAddTodo} onCancel={() => setAddingToCategory(false)} />
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
          <DragOverlay>{activeTodo ? <TodoItemOverlay todo={activeTodo} /> : null}</DragOverlay>
        </DndContext>
        <CompletedItemsAccordion todos={completedTodos} onToggleComplete={handleToggleComplete} onDeleteTodo={handleDeleteTodo} disabled={disabled} />
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
