import React from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/** The tab title of every not-found screen. */
export const NOT_FOUND_TITLE = 'Not found';

export interface NotFoundProps {
  /** What was not found, e.g. "Task not found". */
  title?: string;
  /** One sentence saying why, in plain words. */
  message?: string;
  /** Where the way back goes: the entity's list, or the dashboard for an unknown page. */
  backTo?: string;
  backLabel?: string;
  /**
   * Whether this screen sets the tab title. A page that owns the title (and
   * shows this screen in place of its content) sets "Not found" itself, so the
   * two hooks do not undo each other on unmount.
   */
  setsDocumentTitle?: boolean;
}

/**
 * The one not-found screen: an unknown page, or a task, goal, plan or
 * automation id that does not exist (or is not a valid id at all). A neutral
 * heading, one sentence and a link back to where the user can pick again.
 */
export const NotFound: React.FC<NotFoundProps> = ({
  title = 'Page not found',
  message = 'This page does not exist or has moved.',
  backTo = '/',
  backLabel = 'Back to dashboard',
  setsDocumentTitle = true,
}) => {
  useDocumentTitle(NOT_FOUND_TITLE, setsDocumentTitle);
  return (
    <div className="text-center py-20 px-4" data-testid="not-found">
      <h2 className="text-xl font-semibold text-gray-700 mb-2">{title}</h2>
      <p className="text-gray-500 mb-4">{message}</p>
      <Link to={backTo} className="text-primary-600 hover:text-primary-700 underline">
        {backLabel}
      </Link>
    </div>
  );
};

export default NotFound;
