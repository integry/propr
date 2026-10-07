import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Edit3 } from 'lucide-react';
import { PlanOverflowMenu } from './PlanOverflowMenu';

const renderMenu = () => render(
  <PlanOverflowMenu isDeleting={false} deleteDisabled={false} deleteTitle="Delete Plan" onDelete={vi.fn()}
    items={[{ label: 'Revise', icon: <Edit3 size={14} />, onSelect: vi.fn() }]} />,
);

describe('PlanOverflowMenu keyboard behaviour', () => {
  it('focuses the first action on open and cycles with the arrow keys', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More plan actions' }));
    const revise = screen.getByRole('menuitem', { name: 'Revise' });
    expect(revise).toHaveFocus();
    fireEvent.keyDown(revise, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Delete plan' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(revise).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'More plan actions' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Revise' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('PlanOverflowMenu sheet variant', () => {
  it('opens the actions in a bottom sheet instead of a popover anchored to the trigger', () => {
    const onDelete = vi.fn();
    render(
      <PlanOverflowMenu isDeleting={false} deleteDisabled={false} deleteTitle="Delete Plan" onDelete={onDelete} variant="sheet"
        items={[{ label: 'Undo', icon: <Edit3 size={14} />, onSelect: vi.fn() }]} />,
    );
    const trigger = screen.getByRole('button', { name: 'More plan actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Plan actions' });
    expect(sheet.className).toContain('rounded-t-xl');
    expect(sheet.parentElement!.className).toContain('fixed inset-0');
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Undo', 'Delete plan']);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete plan' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
