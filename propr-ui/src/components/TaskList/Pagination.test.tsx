import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination';

const footer = (props: Partial<React.ComponentProps<typeof Pagination>> = {}) => render(
  <Pagination totalTasks={14919} tasksPerPage={50} currentPage={0} setCurrentPage={vi.fn()} {...props} />,
);

describe('Pagination', () => {
  it('states the slice and the total, counted in tasks', () => {
    footer();
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^Showing 1–50 of 14,919 tasks$/);
  });

  it('ends the range at the tasks the page returned', () => {
    footer({ currentPage: 1, returnedCount: 7 });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^Showing 51–57 of 14,919 tasks$/);
  });

  it('ends the last page at the total', () => {
    footer({ currentPage: 298 });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^Showing 14,901–14,919 of 14,919 tasks$/);
  });

  it('stays in a pinned footer when every task fits on one page', () => {
    footer({ totalTasks: 3, returnedCount: 3, pinned: true });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^Showing 1–3 of 3 tasks$/);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('counts no tasks in a pinned footer', () => {
    footer({ totalTasks: 0, returnedCount: 0, pinned: true });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^0 tasks$/);
  });

  it('leaves an unpinned single page without a footer', () => {
    footer({ totalTasks: 3 });
    expect(screen.queryByTestId('pagination-summary')).toBeNull();
  });
});
