import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import ActionBar from './ActionBar';
import ContextStrip from './ContextStrip';

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
}

const commonProps = {
  historyItemWithPaths: {
    promptPath: '/tmp/prompt.md',
    logsPath: '/tmp/task.log',
  },
  stoppingExecution: false,
  onStopExecution: () => {},
  onViewPrompt: () => {},
  onViewLogs: () => {},
  onDeleteTask: () => {},
  onFollowUp: () => {},
};

describe('TaskDetails mobile actions', () => {
  test.each([320, 390])('keeps active task controls labeled and wrappable at %ipx', width => {
    setViewportWidth(width);
    const { container } = render(<ActionBar {...commonProps} currentStatus="PROCESSING" />);

    expect(screen.getByRole('button', { name: 'Prompt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('flex-wrap', 'w-full', 'min-w-0');
  });

  test.each([320, 390])('keeps completed task follow-up access labeled at %ipx', width => {
    setViewportWidth(width);
    render(<ActionBar {...commonProps} currentStatus="COMPLETED" />);

    expect(screen.getByRole('button', { name: 'Follow Up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prompt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logs' })).toBeInTheDocument();
  });

  test.each([320, 390])('keeps task issue and PR links in a wrapping metadata row at %ipx', width => {
    setViewportWidth(width);
    const { container } = render(
      <ContextStrip
        taskInfo={{
          repoOwner: 'integry',
          repoName: 'propr-with-a-long-mobile-name',
          number: 1727,
          type: 'issue',
        }}
        modelName="gpt-5.6-sol"
        prInfo={{ url: 'https://github.com/integry/propr/pull/1800', number: 1800 }}
        mobileMetadataOnly
      />,
    );

    expect(screen.getByRole('link', { name: /PR #1800/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /#1727/ })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('flex-wrap', 'min-w-0');
  });
});

describe('Task action overflow', () => {
  test('keeps delete behind the menu, supports Escape, and invokes it only after selection', () => {
    const onDeleteTask = vi.fn();
    render(<ActionBar {...commonProps} onDeleteTask={onDeleteTask} currentStatus="COMPLETED" />);
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'More task actions' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    expect(onDeleteTask).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Delete' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDeleteTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test.each(['PROCESSING', 'CLAUDE_EXECUTION_STARTED', 'CLAUDE_EXECUTION_COMPLETED'])('keeps active task deletion disabled in %s', currentStatus => {
    render(<ActionBar {...commonProps} currentStatus={currentStatus} />);
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('permits deletion after stopping fails', () => {
    render(<ActionBar {...commonProps} currentStatus="PROCESSING" stopFailed />);
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeEnabled();
  });

  test('keeps Stop for a newer run that is still working while an earlier run is shown', () => {
    const onStop = vi.fn();
    const onStopExecution = vi.fn();
    render(<ActionBar {...commonProps} onStopExecution={onStopExecution} currentStatus="COMPLETED" liveRun={{ number: 8, stopping: false, onStop }} />);

    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toHaveAttribute('title', 'Stop Run 8, which is still running');
    // The task is still working, so a follow-up waits, as it does on the newest run.
    expect(screen.queryByRole('button', { name: 'Follow Up' })).toBeNull();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStopExecution).not.toHaveBeenCalled();
  });
});


describe('TaskDetails collapsed mobile header', () => {
  test('folds Follow Up, Prompt, Logs and Delete into a bottom action sheet', () => {
    const onFollowUp = vi.fn();
    render(<ActionBar {...commonProps} onFollowUp={onFollowUp} currentStatus="COMPLETED" compact />);

    expect(screen.queryByRole('button', { name: 'Follow Up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prompt' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'More task actions' });
    expect(trigger).toHaveClass('h-11', 'w-11', 'rounded-full');
    fireEvent.click(trigger);

    const sheet = screen.getByRole('dialog', { name: 'Task actions' });
    expect(sheet).toHaveClass('bottom-0', 'inset-x-0');
    expect(sheet.parentElement).toHaveClass('fixed', 'inset-0');
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Follow Up', 'Prompt', 'Logs', 'Delete']);
    screen.getAllByRole('menuitem').forEach(item => expect(item).toHaveClass('min-h-12', 'w-full'));
    expect(screen.getByRole('menuitem', { name: 'Follow Up' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass('text-red-600');
    expect(screen.getAllByRole('button').at(-1)).toHaveTextContent('Cancel');
    // Cancel is a separate card below the actions, never a row right under Delete.
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(screen.getByRole('menu')).not.toContainElement(cancel);
    expect(screen.getByRole('menu')).toHaveClass('rounded-2xl', 'bg-white');
    expect(cancel).toHaveClass('rounded-2xl', 'bg-white');
    expect(sheet).toHaveClass('gap-2');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Follow Up' }));
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  test('closes the sheet from Cancel, the scrim and Escape without acting', () => {
    const onDeleteTask = vi.fn();
    render(<ActionBar {...commonProps} onDeleteTask={onDeleteTask} currentStatus="COMPLETED" compact />);
    const trigger = screen.getByRole('button', { name: 'More task actions' });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('task-action-sheet-scrim'));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Delete' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onDeleteTask).not.toHaveBeenCalled();
  });

  test('keeps Stop out of the sheet while the task works', () => {
    render(<ActionBar {...commonProps} currentStatus="PROCESSING" compact />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Follow Up' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
  });

  test('opens the full mobile summary\'s overflow as the same sheet', () => {
    render(<ActionBar {...commonProps} currentStatus="COMPLETED" sheet />);

    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
    expect(screen.getByRole('dialog', { name: 'Task actions' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Delete']);
  });

  test('reads as the pull request then the task title on one line', () => {
    const { container } = render(
      <ContextStrip
        taskInfo={{ repoOwner: 'acme', repoName: 'web', number: 41, type: 'issue', title: 'Render visual previews full width' }}
        modelName="gpt-6-astra"
        prInfo={{ url: 'https://github.com/acme/web/pull/42', number: 42 }}
        mobileCompact
      />,
    );

    expect(container.textContent).toBe('#42:Render visual previews full width');
    expect(screen.getByRole('link', { name: 'PR #42' })).toHaveAttribute('href', 'https://github.com/acme/web/pull/42');
    expect(screen.getByText('Render visual previews full width')).toHaveClass('truncate');
    expect(screen.queryByText('acme/web')).toBeNull();
    expect(screen.queryByText('gpt-6-astra')).toBeNull();
  });

  test('falls back to the repository when the task has no title yet', () => {
    const { container } = render(
      <ContextStrip
        taskInfo={{ repoOwner: 'acme', repoName: 'web', number: 41, type: 'issue' }}
        modelName="gpt-6-astra"
        prInfo={{ url: 'https://github.com/acme/web/pull/42', number: 42 }}
        mobileCompact
      />,
    );

    expect(container.textContent).toBe('#42:acme/web');
  });
});
