import React from 'react';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { RepoTodoCategory, RepoTodo } from '../../../api/repoTodosApi';
import SortableTodoItem from './SortableTodoItem';
import CategoryHeader from './CategoryHeader';
import AddTodoInput from './AddTodoInput';

export interface CategorySectionProps {
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
  isSortable?: boolean;
  isAddingTodo?: boolean;
  onConfirmAddTodo?: (content: string) => void;
  onCancelAddTodo?: () => void;
}

interface TodoListContentProps {
  todos: RepoTodo[];
  selectedTodoIds: Set<string>;
  onToggleSelect: (todoId: string) => void;
  onToggleComplete: (todoId: string, isCompleted: boolean) => void;
  onDeleteTodo: (todoId: string) => void;
  onEditTodo: (todoId: string, content: string) => void;
  disabled?: boolean;
  isOver: boolean;
  categoryId: string | null;
  isAddingTodo: boolean;
  onConfirmAddTodo?: (content: string) => void;
  onCancelAddTodo?: () => void;
}

const TodoListContent: React.FC<TodoListContentProps> = ({
  todos,
  selectedTodoIds,
  onToggleSelect,
  onToggleComplete,
  onDeleteTodo,
  onEditTodo,
  disabled,
  isOver,
  categoryId,
  isAddingTodo,
  onConfirmAddTodo,
  onCancelAddTodo,
}) => {
  const todoIds = todos.map((t) => t.todoId);
  const showAddTodoInput = isAddingTodo && onConfirmAddTodo && onCancelAddTodo;

  return (
    <>
      {showAddTodoInput && (
        <div className="mb-2">
          <AddTodoInput
            categoryId={categoryId}
            onAdd={onConfirmAddTodo}
            onCancel={onCancelAddTodo}
          />
        </div>
      )}
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
        <p className={`text-xs text-slate-400 italic py-2 px-2 ${isOver ? 'text-teal-600' : ''}`}>
          {isOver ? 'Drop here to add to this category' : 'No items in this category'}
        </p>
      )}
    </>
  );
};

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
  isSortable = false,
  isAddingTodo = false,
  onConfirmAddTodo,
  onCancelAddTodo,
}) => {
  const categoryId = category?.categoryId || null;
  const droppableId = `category-drop-${categoryId || 'uncategorized'}`;

  // Make category sortable (for reordering categories themselves)
  const {
    attributes: sortableAttributes,
    listeners: sortableListeners,
    setNodeRef: setSortableNodeRef,
    transform: sortableTransform,
    transition: sortableTransition,
    isDragging: isCategoryDragging,
  } = useSortable({
    id: category?.categoryId || 'uncategorized',
    disabled: !isSortable || !category, // Don't allow sorting uncategorized
  });

  // Make category a drop target for empty categories
  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: droppableId,
    data: {
      type: 'category',
      categoryId: categoryId,
    },
  });

  const sortableStyle = isSortable && category ? {
    transform: CSS.Transform.toString(sortableTransform),
    transition: sortableTransition,
  } : {};

  return (
    <div
      ref={isSortable && category ? setSortableNodeRef : undefined}
      style={sortableStyle}
      className={`mb-4 ${isCategoryDragging ? 'opacity-50 z-50' : ''}`}
    >
      {/* Category Header */}
      <CategoryHeader
        category={category}
        todoCount={todos.length}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        onAddTodo={onAddTodo}
        onEditCategory={onEditCategory}
        onDeleteCategory={onDeleteCategory}
        disabled={disabled}
        isSortable={isSortable}
        sortableAttributes={sortableAttributes}
        sortableListeners={sortableListeners}
      />

      {/* Todos */}
      {isExpanded && (
        <div
          ref={setDroppableNodeRef}
          className={`ml-4 mt-1 space-y-1.5 min-h-[40px] rounded-md transition-colors ${
            isOver ? 'bg-teal-50 border-2 border-dashed border-teal-300' : ''
          }`}
        >
          <TodoListContent
            todos={todos}
            selectedTodoIds={selectedTodoIds}
            onToggleSelect={onToggleSelect}
            onToggleComplete={onToggleComplete}
            onDeleteTodo={onDeleteTodo}
            onEditTodo={onEditTodo}
            disabled={disabled}
            isOver={isOver}
            categoryId={categoryId}
            isAddingTodo={isAddingTodo}
            onConfirmAddTodo={onConfirmAddTodo}
            onCancelAddTodo={onCancelAddTodo}
          />
        </div>
      )}
    </div>
  );
};

export default CategorySection;
