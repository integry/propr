import React from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import type { FileOverlap } from '../../api/fileChangesApi';

const MAX_LISTED_PATHS = 3;

const otherTaskLabel = (overlap: FileOverlap) => {
  if (!overlap.issueNumber) return 'another task';
  return /pr|pull/i.test(overlap.taskType ?? '') ? `PR #${overlap.issueNumber}` : `issue #${overlap.issueNumber}`;
};

/** A small, non-blocking notice: other active tasks are changing the same files as this one. */
const FileOverlapNotice: React.FC<{ overlaps: FileOverlap[] }> = ({ overlaps }) => {
  if (!overlaps.length) return null;
  return (
    <div role="note" aria-label="Also being changed by other tasks" className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <Users className="mt-px h-3.5 w-3.5 flex-none text-amber-600" aria-hidden="true" />
      <ul className="m-0 min-w-0 flex-1 list-none space-y-1 p-0">
        {overlaps.map(overlap => {
          const listed = overlap.paths.slice(0, MAX_LISTED_PATHS);
          const more = Math.max(overlap.totalPaths, overlap.paths.length) - listed.length;
          return (
            <li key={overlap.taskId} className="min-w-0">
              Also being changed by{' '}
              <Link to={`/tasks/${encodeURIComponent(overlap.taskId)}`} className="font-medium text-amber-900 underline underline-offset-2 hover:text-amber-950">
                {otherTaskLabel(overlap)}
              </Link>
              {': '}
              <span className="font-mono text-[11px] [overflow-wrap:anywhere]">{listed.join(', ')}</span>
              {more > 0 && <span> and {more} more</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default FileOverlapNotice;
