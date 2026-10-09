import React from 'react';
import { ExternalLink } from 'lucide-react';
import { RepoTodo } from '../../../api/repoTodosApi';

export interface TodoIssueLinkProps {
  todo: Pick<RepoTodo, 'linkedIssueRepository' | 'linkedIssueNumber'>;
  className?: string;
}

/** Chip linking a to-do to the GitHub issue opened when a task was launched from it. */
const TodoIssueLink: React.FC<TodoIssueLinkProps> = ({ todo, className = '' }) => {
  if (!todo.linkedIssueRepository || !todo.linkedIssueNumber) return null;
  const href = `https://github.com/${todo.linkedIssueRepository}/issues/${todo.linkedIssueNumber}`;
  // Keep clicks and drags on the chip from selecting or dragging the to-do.
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      onPointerDown={stop}
      title={`Open ${todo.linkedIssueRepository}#${todo.linkedIssueNumber} on GitHub`}
      className={`inline-flex items-center gap-1 text-[10px] text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-1.5 py-0.5 rounded ${className}`}
    >
      <ExternalLink size={10} />
      #{todo.linkedIssueNumber}
    </a>
  );
};

export default TodoIssueLink;
