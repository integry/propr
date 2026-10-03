import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination';

const footer = (props: Partial<React.ComponentProps<typeof Pagination>> = {}) => render(
  <Pagination totalTasks={14919} tasksPerPage={50} currentPage={0} setCurrentPage={vi.fn()} {...props} />,
);

describe('Pagination', () => {
  it('counts the tasks of the page and the pull-request rows they fold into', () => {
    footer({ groupCount: 11 });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent('Showing tasks 1–50 of 14,919 · 11 pull requests on this page');
  });

  it('names rows when some are not pull requests', () => {
    footer({ groupCount: 1, groupNoun: 'row', currentPage: 2 });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent('Showing tasks 101–150 of 14,919 · 1 row on this page');
  });

  it('leaves the row count out when every task is its own row', () => {
    footer({ groupCount: 19, currentPage: 298 });
    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(/^Showing tasks 14,901–14,919 of 14,919$/);
  });
});
