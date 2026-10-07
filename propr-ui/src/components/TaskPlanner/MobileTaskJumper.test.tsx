import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileTaskJumper } from './MobileTaskJumper';

const titles = Array.from({ length: 17 }, (_, i) => `Task title ${i + 1}`);

describe('MobileTaskJumper', () => {
  it('shows the active task position and title', () => {
    render(<MobileTaskJumper taskTitles={titles} activeIndex={2} onSelect={vi.fn()} />);
    expect(screen.getByTestId('mobile-task-jumper')).toHaveTextContent('Task 3 of 17Task title 3');
  });

  it('opens a sheet of every task and jumps to the one tapped', () => {
    const onSelect = vi.fn();
    render(<MobileTaskJumper taskTitles={titles} activeIndex={0} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('mobile-task-jumper'));
    const sheet = screen.getByRole('dialog', { name: 'Jump to task' });
    expect(sheet.querySelectorAll('li')).toHaveLength(17);
    expect(screen.getByRole('button', { name: '1Task title 1' })).toHaveAttribute('aria-current', 'step');

    fireEvent.click(screen.getByRole('button', { name: '14Task title 14' }));
    expect(onSelect).toHaveBeenCalledWith(13);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape without jumping', () => {
    const onSelect = vi.fn();
    render(<MobileTaskJumper taskTitles={titles} activeIndex={0} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('mobile-task-jumper'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
