import React from 'react';
import { GripVertical } from 'lucide-react';
import { RepoTodo } from '../../../api/repoTodosApi';

export interface TodoItemOverlayProps {
  todo: RepoTodo;
}

const TodoItemOverlay: React.FC<TodoItemOverlayProps> = ({ todo }) => (
  <div className="flex items-start gap-2 p-2.5 rounded-lg border bg-white border-teal-300 shadow-lg">
    <div className="flex-shrink-0 mt-0.5 text-slate-400">
      <GripVertical size={14} />
    </div>
    <div className="flex-shrink-0 w-4 h-4 mt-0.5 rounded border border-slate-300" />
    <div className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-2 border-slate-300" />
    <p className="flex-1 text-sm text-slate-700 break-words whitespace-pre-wrap">{todo.content}</p>
  </div>
);

export default TodoItemOverlay;
