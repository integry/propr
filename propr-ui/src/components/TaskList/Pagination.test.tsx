import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination';

const footer = (props: Partial<React.ComponentProps<typeof Pagination>> = {}) => render(
  <Pagination totalTasks={14919} tasksPerPage={50} currentPage={0} setCurrentPage={vi.fn()} {...props} />,
);

describe('Pagination', () => {
  it('states the slice and the total, counted in runs', () => {
    footer();
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^Showing 1–50 of 14,919 runs$/);
  });

  it('ends the range at the runs the page returned', () => {
    footer({ currentPage: 1, returnedCount: 32 });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^Showing 51–82 of 14,919 runs$/);
  });

  it('ends the last page at the total', () => {
    footer({ currentPage: 298 });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^Showing 14,901–14,919 of 14,919 runs$/);
  });
});
