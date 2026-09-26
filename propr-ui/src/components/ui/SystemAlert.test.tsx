import { fireEvent, render, screen } from '@testing-library/react';
import { ChartNoAxesColumn } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { SystemAlert } from './SystemAlert';

describe('SystemAlert', () => {
  it('contains errors in a styled alert with an optional retry action', () => {
    const onRetry = vi.fn();
    render(<SystemAlert onRetry={onRetry}>HTTP 503: Service unavailable</SystemAlert>);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('w-full', 'rounded-md', 'border-red-100', 'bg-red-50', 'p-4', 'text-sm', 'font-medium', 'text-red-700');
    expect(alert.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('centers subdued empty-state content', () => {
    render(
      <div className="h-32">
        <SystemAlert variant="empty" icon={<ChartNoAxesColumn aria-hidden="true" />}>No activity data</SystemAlert>
      </div>,
    );

    expect(screen.getByRole('status')).toHaveClass('h-full', 'items-center', 'justify-center', 'text-center', 'text-sm', 'text-slate-400');
  });
});
