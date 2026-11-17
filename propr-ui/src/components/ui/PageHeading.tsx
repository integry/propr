import React from 'react';

/**
 * The one page title style: large and bold, set in the page's anchored header
 * row. Every top-level page (Tasks, Plans, Goals, Inbox, Automations,
 * Repositories, Access, the logs) and a goal's own page use it, so moving
 * between them never changes the title's size, weight or colour.
 */
export const PAGE_HEADING_CLASSES = 'min-w-0 text-lg font-bold text-gray-800 sm:text-2xl';

interface PageHeadingProps {
  children: React.ReactNode;
  id?: string;
  title?: string;
  /** Layout-only additions (truncation, wrapping); the type style stays fixed. */
  className?: string;
}

export const PageHeading: React.FC<PageHeadingProps> = ({ children, id, title, className = '' }) => (
  <h1 id={id} title={title} className={`${PAGE_HEADING_CLASSES} ${className}`.trim()}>
    {children}
  </h1>
);

export default PageHeading;
