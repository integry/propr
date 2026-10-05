import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ExecutionEventLog from './ExecutionEventLog';
import ThinkingLog from './ThinkingLog';
import type { LiveEvent } from './types';

const defaultProps = {
  onToggleCollapse: vi.fn(),
  lastThought: null,
  isTaskActive: true,
  taskInfo: null,
};

describe('ExecutionEventLog', () => {
  it('does not materialize historical event details while collapsed', () => {
    const commandRead = vi.fn();
    const input = Object.defineProperty({}, 'command', {
      configurable: true,
      enumerable: true,
      get: () => {
        commandRead();
        return 'npm test';
      },
    });
    const events: LiveEvent[] = [
      { id: 'tool-1', type: 'tool_use', toolName: 'Bash', input },
      { id: 'thought-2', type: 'thought', content: 'Waiting for the test result' },
    ];

    const { rerender } = render(
      <ExecutionEventLog {...defaultProps} events={events} collapsed={true} />,
    );

    expect(screen.getByText('EXECUTION LOG (2)')).toBeTruthy();
    expect(commandRead).not.toHaveBeenCalled();
    expect(document.querySelector('#execution-event-log-content')?.children).toHaveLength(1);
    expect(screen.queryByText('BASH')).toBeNull();

    rerender(<ExecutionEventLog {...defaultProps} events={events} collapsed={false} />);

    expect(commandRead).toHaveBeenCalled();
    expect(screen.getByText('TERMINAL OUTPUT (2)')).toBeTruthy();
    expect(screen.getByText('BASH')).toBeTruthy();
  });

  it('keeps the collapsed summary interactive without rendering the hidden history', () => {
    const onToggleCollapse = vi.fn();
    render(
      <ExecutionEventLog
        {...defaultProps}
        events={[{ id: 'thought-1', type: 'thought', content: 'A current summary' }]}
        collapsed={true}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    expect(screen.getByText('Thinking: A current summary')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /execution log/i }));
    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });

  it('discloses output discarded by retention instead of implying the count is complete', () => {
    const events: LiveEvent[] = [{ id: 'tool-1', type: 'tool_use', toolName: 'Bash', input: { command: 'npm test' } }];
    const { rerender } = render(<ExecutionEventLog {...defaultProps} events={events} collapsed={false} omittedEventCount={0} historyTruncated />);
    expect(screen.getByText('TERMINAL OUTPUT (1+)')).toBeTruthy();
    const notice = screen.getByRole('note');
    expect(notice.textContent).toContain('Earlier output from this run exceeded the live log size limit and was discarded.');
    expect(notice.textContent).not.toContain('keeps every message');

    rerender(<ExecutionEventLog {...defaultProps} events={events} collapsed={false} omittedEventCount={3} />);
    expect(screen.getByText('TERMINAL OUTPUT (4)')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe('3 earlier terminal events are not shown. The implementation log keeps every message.');
  });
});

describe('ThinkingLog', () => {
  it('renders narration and a published checkpoint without raw JSON', () => {
    const declaration = JSON.stringify({
      checkpointReady: true,
      message: 'feat(goals): publish stable work',
      include: ['src/goals.ts', 'test/goals.test.ts'],
      exclude: ['src/follow-up.ts'],
      summary: 'The coherent implementation slice and its tests are ready.',
    });

    render(<ThinkingLog checkpointOutcome={{
      kind: 'agent', state: 'completed', commitSha: 'abc1234',
      message: 'feat(goals): publish stable work',
      include: ['src/goals.ts', 'test/goals.test.ts'], exclude: ['src/follow-up.ts'],
      summary: 'The coherent implementation slice and its tests are ready.', error: null,
      createdAt: '2026-09-10T00:01:31.000Z',
    }} events={[{
      id: 'checkpoint-1', type: 'thought', timestamp: '2026-09-10T00:01:30.000Z',
      content: `Stable work is **ready**.\n\
\`\`\`json\n${declaration}\n\`\`\``,
      relativeTime: '12m 4s',
    }]} />);

    expect(screen.getByTestId('goal-checkpoint-event')).toHaveClass('bg-emerald-50/40');
    expect(screen.getByText('CHECKPOINT')).toBeInTheDocument();
    expect(screen.getByText('Stable work is', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('ready').tagName).toBe('STRONG');
    expect(screen.getByText('Checkpoint published')).toBeInTheDocument();
    expect(screen.getByText('feat(goals): publish stable work')).toBeInTheDocument();
    expect(screen.getByText('The coherent implementation slice and its tests are ready.')).toBeInTheDocument();
    expect(screen.getByText('2 included · 1 excluded')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
    expect(screen.getByText('12m 4s')).toHaveClass('text-slate-500');
    expect(screen.queryByText(declaration)).not.toBeInTheDocument();
    expect(screen.queryByText('ACTION')).not.toBeInTheDocument();
  });

  it.each([
    ['an unsafe path', { message: 'feat: unsafe', include: ['../outside.ts'] }, /normalized repository-relative file/],
    ['an empty message', { message: '' }, /non-empty string/],
    ['overlapping paths', { message: 'feat: overlap', include: ['src/a.ts'], exclude: ['src/a.ts'] }, /both included and excluded/],
  ])('renders %s as a muted rejected checkpoint instead of raw JSON', (_name, fields, error) => {
    const declaration = JSON.stringify({ checkpointReady: true, ...fields });
    render(<ThinkingLog events={[{
      id: `rejected-${_name}`, type: 'thought', content: `This scope needs checking.\n${declaration}`,
      relativeTime: '13m 2s',
    }]} />);

    const rejected = screen.getByTestId('goal-checkpoint-rejected-event');
    expect(rejected).toHaveClass('bg-slate-50/70');
    expect(screen.getByText('This scope needs checking.')).toBeInTheDocument();
    expect(screen.getByText('Checkpoint rejected')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(error);
    expect(screen.queryByText(declaration)).not.toBeInTheDocument();
  });

  it('does not attach stale durable state to a newer checkpoint request', () => {
    const content = JSON.stringify({ checkpointReady: true, message: 'feat: new request' });
    render(<ThinkingLog checkpointOutcome={{
      kind: 'agent', state: 'failed', commitSha: null, message: 'feat: new request',
      include: null, exclude: null, summary: null, error: 'Push failed',
      createdAt: '2026-09-10T00:01:00.000Z',
    }} events={[{
      id: 'checkpoint-new', type: 'thought', content, timestamp: '2026-09-10T00:02:00.000Z',
    }]} />);

    expect(screen.getByText('Checkpoint request')).toBeInTheDocument();
    expect(screen.queryByText('Push failed')).not.toBeInTheDocument();
  });

  it('keeps an older declaration neutral when only the latest checkpoint outcome is available', () => {
    render(<ThinkingLog checkpointOutcome={{
      kind: 'agent', state: 'completed', commitSha: 'def5678', message: 'feat: second slice',
      include: null, exclude: null, summary: null, error: null,
      createdAt: '2026-09-10T00:03:01.000Z',
    }} events={[
      {
        id: 'checkpoint-first', type: 'thought', timestamp: '2026-09-10T00:01:00.000Z',
        content: JSON.stringify({ checkpointReady: true, message: 'feat: first slice' }),
      },
      {
        id: 'checkpoint-second', type: 'thought', timestamp: '2026-09-10T00:03:00.000Z',
        content: JSON.stringify({ checkpointReady: true, message: 'feat: second slice' }),
      },
    ]} />);

    expect(screen.getByText('Checkpoint request')).toBeInTheDocument();
    expect(screen.getByText('Checkpoint published')).toBeInTheDocument();
    expect(screen.getByText('def5678')).toBeInTheDocument();
    expect(screen.queryByText('Checkpoint requested')).not.toBeInTheDocument();
  });

  it('keeps an agent declaration neutral when the latest outcome is the final checkpoint', () => {
    render(<ThinkingLog checkpointOutcome={{
      kind: 'final', state: 'completed', commitSha: 'final123', message: 'Final checkpoint',
      include: null, exclude: null, summary: null, error: null,
      createdAt: '2026-09-10T00:04:00.000Z',
    }} events={[{
      id: 'checkpoint-before-final', type: 'thought', timestamp: '2026-09-10T00:03:00.000Z',
      content: JSON.stringify({ checkpointReady: true, message: 'feat: agent slice' }),
    }]} />);

    expect(screen.getByText('Checkpoint request')).toBeInTheDocument();
    expect(screen.queryByText('Checkpoint requested')).not.toBeInTheDocument();
    expect(screen.queryByText('final123')).not.toBeInTheDocument();
  });

  it.each(['jsonc', 'JSON5', 'javascript'])(
    'removes a declaration-only fence with the %s info string',
    infoString => {
      const declaration = JSON.stringify({ checkpointReady: true, message: `test: ${infoString} fence` });
      const { container } = render(<ThinkingLog events={[{
        id: `checkpoint-${infoString}`, type: 'thought',
        content: `Narration before the declaration.\n\`\`\`${infoString}\n${declaration}\n\`\`\``,
      }]} />);

      expect(screen.getByText('Narration before the declaration.')).toBeInTheDocument();
      expect(container.querySelector('pre')).toBeNull();
      expect(screen.queryByText(declaration)).not.toBeInTheDocument();
    },
  );

  it('collapses whitespace around a declaration embedded in narration', () => {
    const declaration = JSON.stringify({ checkpointReady: true, message: 'test: inline declaration' });
    render(<ThinkingLog events={[{
      id: 'checkpoint-inline', type: 'thought',
      content: `Ready:  ${declaration}   — continuing.`,
    }]} />);

    expect(screen.getByText('Ready: — continuing.')).toHaveTextContent(/^Ready: — continuing\.$/);
  });

  it('shows a matching worker publication failure on the latest checkpoint', () => {
    const content = JSON.stringify({ checkpointReady: true, message: 'feat: publish this slice' });
    render(<ThinkingLog checkpointOutcome={{
      kind: 'agent', state: 'failed', commitSha: null, message: 'feat: publish this slice',
      include: null, exclude: null, summary: null, error: 'Push failed after the request was accepted',
      createdAt: '2026-09-10T00:02:01.000Z',
    }} events={[{
      id: 'checkpoint-failed', type: 'thought', content, timestamp: '2026-09-10T00:02:00.000Z',
    }]} />);

    expect(screen.getByText('Checkpoint failed')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Push failed after the request was accepted');
  });

  it('reuses parsed checkpoint output when polling recreates an event', () => {
    const content = JSON.stringify({ checkpointReady: true, message: 'test: cache parser result 8271' });
    const parse = vi.spyOn(JSON, 'parse');
    const { rerender } = render(<ThinkingLog events={[{ id: 'cached-1', type: 'thought', content }]} />);
    const parsesAfterFirstRender = parse.mock.calls.length;

    rerender(<ThinkingLog events={[{ id: 'cached-1', type: 'thought', content }]} />);

    expect(parsesAfterFirstRender).toBeGreaterThan(0);
    expect(parse).toHaveBeenCalledTimes(parsesAfterFirstRender);
    parse.mockRestore();
  });

  it('discloses output discarded by retention in the readable view', () => {
    const events: LiveEvent[] = [{ id: 'thought-1', type: 'thought', content: 'Still working' }];
    const { rerender } = render(<ThinkingLog events={events} historyTruncated />);
    expect(screen.getByRole('note').textContent).toContain('The oldest messages may be missing.');
    rerender(<ThinkingLog events={events} />);
    expect(screen.queryByRole('note')).toBeNull();
  });
  it('folds consecutive reasoning into one timed disclosure and keeps actions in the flow', () => {
    render(<ThinkingLog events={[
      { id: 'a1', type: 'thought', content: 'Reading the handler first.', timestamp: '2026-09-10T00:00:00.000Z' },
      { id: 'a2', type: 'thought', content: 'The label check is too loose.', timestamp: '2026-09-10T00:00:06.000Z' },
      { id: 'b1', type: 'thought', content: 'Update the label check and rerun lint.', timestamp: '2026-09-10T00:00:14.000Z' },
    ]} />);
    const toggle = screen.getByRole('button', { name: 'Thought for 14s (2 analysis steps)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Reading the handler first.')).toBeNull();
    expect(screen.getByText('Update the label check and rerun lint.')).toBeInTheDocument();
    expect(screen.queryByText('Thinking Process')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(panel).toHaveClass('border-l-2', 'border-slate-200', 'ml-2', 'pl-3');
    expect(panel).toHaveTextContent('Reading the handler first.');
  });

  it('keeps the newest reasoning open while the run streams', () => {
    const events: LiveEvent[] = [{ id: 'a1', type: 'thought', content: 'Dependencies are missing; installing them.' }];
    const { rerender } = render(<ThinkingLog events={events} streaming />);
    expect(screen.getByRole('button', { name: 'Thought (1 analysis step)' })).toHaveAttribute('aria-expanded', 'true');
    rerender(<ThinkingLog events={[...events, { id: 'b1', type: 'thought', content: 'Update the lockfile.' }]} streaming />);
    expect(screen.getByRole('button', { name: 'Thought (1 analysis step)' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('never shows a raw tool response payload', () => {
    render(<ThinkingLog events={[
      { id: 'leak', type: 'thought', content: '{"content":[{"type":"text","text":"[local preview omitted]"}]}' },
      { id: 'wrapped', type: 'thought', content: '{"content":[{"type":"text","text":"Update the review summary."}]}' },
    ]} />);
    expect(document.body.textContent).not.toContain('"content"');
    expect(document.body.textContent).not.toContain('local preview omitted');
    expect(screen.getByText('Update the review summary.')).toBeInTheDocument();
  });
});
