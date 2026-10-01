import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KPICard } from './KPICard';

describe('KPICard', () => {
  it('tells assistive technology its value is loading', () => {
    render(<KPICard title="Active Tasks" value={0} isLoading />);
    expect(screen.getByText('Loading…')).toHaveClass('sr-only');
    expect(screen.getByText('Active Tasks').parentElement).toHaveTextContent('Active TasksLoading…');
  });

  it('drops the loading text once the value lands', () => {
    render(<KPICard title="Completed" value={12} />);
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });
});
