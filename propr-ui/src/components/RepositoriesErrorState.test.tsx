import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepositoriesErrorState } from './RepositoriesErrorState';

describe('RepositoriesErrorState', () => {
  it('leaves the page heading to the page header', () => {
    const onRetry = vi.fn();
    render(<RepositoriesErrorState error="GitHub is unreachable" onRetry={onRetry} />);
    expect(screen.queryByText('Manage Monitored Repositories')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Failed to load repositories']);
    expect(screen.getByText('GitHub is unreachable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
