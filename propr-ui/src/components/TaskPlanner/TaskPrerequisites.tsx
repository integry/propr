import { Link2 } from 'lucide-react';
import type { TaskPrerequisite } from './taskPrerequisiteSteps';

/** Read-only list of the steps a task needs first. Dependencies are edited through refinement or MCP. */
export const TaskPrerequisites: React.FC<{ prerequisites?: TaskPrerequisite[] }> = ({ prerequisites }) => {
  if (!prerequisites?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500" data-testid="task-prerequisites">
      <Link2 size={12} className="text-gray-400" aria-hidden="true" />
      <span className="font-semibold uppercase tracking-wider text-gray-400">Depends on</span>
      {prerequisites.map(prerequisite => (
        <span
          key={prerequisite.id}
          title={prerequisite.title}
          className="max-w-[16rem] truncate rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-gray-600"
        >
          {prerequisite.stepNumber}. {prerequisite.title || 'Untitled task'}
        </span>
      ))}
    </div>
  );
};
