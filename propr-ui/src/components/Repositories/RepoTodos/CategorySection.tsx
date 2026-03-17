import React, { useState } from 'react';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  Plus,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Trash2,
  Edit3,
} from 'lucide-react';
import { RepoTodoCategory, RepoTodo } from '../../../api/repoTodosApi';
import SortableTodoItem from './SortableTodoItem';

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

export default CategorySection;
