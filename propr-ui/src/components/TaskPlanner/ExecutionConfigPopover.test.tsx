import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionConfigPopover } from './ExecutionConfigPopover';
import { UltrafixSettingsControls } from './PlanIssueRowComponents';

function renderConfig(onMaxCyclesChange = vi.fn()) {
  render(
    <div>
      <div data-testid="unrelated-scroller" style={{ overflow: 'auto' }} />
      <ExecutionConfigPopover summary="Opus 5.5 · Ultrafix">
        <UltrafixSettingsControls
          enabled goal={8} maxCycles={5} onGoalChange={vi.fn()} onMaxCyclesChange={onMaxCyclesChange}
          goalPlaceholder="Goal" maxPlaceholder="Max" inputClassName="" goalInputWidthClassName="" maxInputWidthClassName=""
        />
      </ExecutionConfigPopover>
      <button type="button">Elsewhere</button>
    </div>,
  );
  return onMaxCyclesChange;
}

const typeMaxLoops = (value: string) => {
  const input = screen.getByLabelText('Max Loops');
  input.focus();
  fireEvent.change(input, { target: { value } });
};

describe('ExecutionConfigPopover', () => {
  it('commits an edited Max Loops value when an outside click dismisses it', () => {
    const onMaxCyclesChange = renderConfig();
    fireEvent.click(screen.getByTestId('execution-config-button'));
    typeMaxLoops('7');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.queryByRole('dialog', { name: 'Execution config' })).not.toBeInTheDocument();
    expect(onMaxCyclesChange).toHaveBeenCalledWith(7);
  });

  it('commits on Escape and returns focus to the trigger', () => {
    const onMaxCyclesChange = renderConfig();
    const trigger = screen.getByTestId('execution-config-button');
    fireEvent.click(trigger);
    typeMaxLoops('3');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onMaxCyclesChange).toHaveBeenCalledWith(3);
    expect(trigger).toHaveFocus();
  });

  it('moves focus into the dialog when it opens', () => {
    renderConfig();
    fireEvent.click(screen.getByTestId('execution-config-button'));
    expect(screen.getByRole('dialog', { name: 'Execution config' })).toHaveFocus();
  });

  it('stays open when a container that does not hold the trigger scrolls', () => {
    renderConfig();
    fireEvent.click(screen.getByTestId('execution-config-button'));
    fireEvent.scroll(screen.getByTestId('unrelated-scroller'));
    expect(screen.getByRole('dialog', { name: 'Execution config' })).toBeInTheDocument();
  });
});
