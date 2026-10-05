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
  test('folds Follow Up, Prompt and Logs into the overflow menu', () => {
    const onFollowUp = vi.fn();
    render(<ActionBar {...commonProps} onFollowUp={onFollowUp} currentStatus="COMPLETED" compact />);

    expect(screen.queryByRole('button', { name: 'Follow Up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prompt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Follow Up', 'Prompt', 'Logs', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Follow Up' }));
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('keeps Stop out of the menu while the task works', () => {
    render(<ActionBar {...commonProps} currentStatus="PROCESSING" compact />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Follow Up' })).toBeNull();
  });

  test('reads as the pull request then the repository on one line', () => {
    const { container } = render(
      <ContextStrip
        taskInfo={{ repoOwner: 'acme', repoName: 'web', number: 41, type: 'issue' }}
        modelName="gpt-6-astra"
        prInfo={{ url: 'https://github.com/acme/web/pull/42', number: 42 }}
        mobileCompact
      />,
    );

    expect(container.textContent).toBe('PR #42acme/web');
    expect(screen.getByText('acme/web')).toHaveClass('truncate');
    expect(screen.queryByText('gpt-6-astra')).toBeNull();
  });
});
