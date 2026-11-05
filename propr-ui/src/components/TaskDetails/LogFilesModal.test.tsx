import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchLogFile, fetchLogFiles } from '../../api/proprApi';
import LogFilesModal from './LogFilesModal';
import { useLogFilesData } from './useLogFilesData';

const fileName = 'issue-28-2026-10-17T21-15-00-788Z-conversation.json';
const content = JSON.stringify({ message: '[INFO] acceptance [payload]', next: 'next line' });

vi.mock('../../api/proprApi', () => ({
  fetchLogFiles: vi.fn(async () => ({ sessionId: 'session-28', files: { conversation: `/logs/${fileName}` } })),
  fetchLogFile: vi.fn(async () => content),
}));

/** The modal wired to its real data hook, as TaskDetails mounts it, behind a Logs opener. */
function Harness() {
  const data = useLogFilesData();
  const [, rerender] = useState(0);
  return (
    <>
      <button type="button" onClick={() => { void data.fetchLogFilesData('/api/execution/session-28/logs'); rerender(n => n + 1); }}>Logs</button>
      <LogFilesModal
        logFiles={data.logFiles}
        selectedLogFile={data.selectedLogFile}
        loadingLogFile={data.loadingLogFile}
        searchQuery={data.searchQuery}
        searchMatches={data.searchMatches}
        currentMatchIndex={data.currentMatchIndex}
        onClose={data.closeLogFiles}
        onSelectFile={data.fetchLogFile}
        onSearchChange={data.setSearchQuery}
        onPrevMatch={() => data.setCurrentMatchIndex(prev => (prev - 1 + data.searchMatches.length) % data.searchMatches.length)}
        onNextMatch={() => data.setCurrentMatchIndex(prev => (prev + 1) % data.searchMatches.length)}
        logContentRef={data.logContentRef}
      />
    </>
  );
}

async function openLog() {
  const opener = screen.getByRole('button', { name: 'Logs' });
  opener.focus();
  await act(async () => { fireEvent.click(opener); });
  const dialog = await screen.findByRole('dialog', { name: 'Log Files' });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(fileName) })); });
  await within(dialog).findByRole('heading', { name: fileName });
  return { opener, dialog, search: within(dialog).getByRole('textbox', { name: 'Search log' }) };
}

const current = (dialog: HTMLElement) => dialog.querySelector('mark[aria-current="true"]')?.getAttribute('data-match-index');

describe('LogFilesModal', () => {
  beforeEach(() => { render(<Harness />); });
  afterEach(() => { vi.clearAllMocks(); });

  test('searches literal metacharacters, counts what it highlights, and steps through matches', async () => {
    const { dialog, search } = await openLog();
    for (const query of ['[', '(', '\\', '.*', '[payload]']) {
      fireEvent.change(search, { target: { value: query } });
      const expected = JSON.stringify(JSON.parse(content), null, 2).split(query).length - 1;
      expect(dialog.querySelectorAll('mark')).toHaveLength(expected);
      expect(within(dialog).getByRole('status')).toHaveTextContent(expected ? `1 / ${expected}` : 'No matches');
    }

    fireEvent.change(search, { target: { value: '[' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 / 2');
    expect(current(dialog)).toBe('0');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next match' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 / 2');
    expect(current(dialog)).toBe('1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next match' }));
    expect(current(dialog)).toBe('0');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous match' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 / 2');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 / 2');
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true });
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 / 2');

    // A new query starts again at its first match; clearing removes every highlight.
    fireEvent.change(search, { target: { value: 'INFO' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 / 1');
    expect(dialog.querySelector('mark')).toHaveTextContent('INFO');
    fireEvent.change(search, { target: { value: 'info' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 / 1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear log search' }));
    expect(search).toHaveValue('');
    expect(dialog.querySelectorAll('mark')).toHaveLength(0);
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  test('is a named modal dialog that Escape closes, returning focus to its opener, and reopens with a fresh search', async () => {
    const { opener, dialog, search } = await openLog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Close log files' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '[' } });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();

    const reopened = await openLog();
    expect(reopened.search).toHaveValue('');
    fireEvent.click(within(reopened.dialog).getByRole('button', { name: 'Close log files' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  test('keeps Tab inside the dialog', async () => {
    const { dialog } = await openLog();
    const close = within(dialog).getByRole('button', { name: 'Close log files' });
    const content = within(dialog).getByTestId('log-file-content');
    content.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(content).toHaveFocus();
  });
});

describe('LogFilesModal file sizes', () => {
  afterEach(() => { vi.clearAllMocks(); });

  const listedSizes = async () => {
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Logs' })); });
    const list = within(await screen.findByRole('dialog', { name: 'Log Files' })).getByTestId('log-file-list');
    return within(list).getAllByRole('button').map(button => button.textContent);
  };

  test('lists execution-backed logs without asserting a size the API did not report, and without fetching their bodies', async () => {
    vi.mocked(fetchLogFiles).mockResolvedValueOnce({
      sessionId: 'session-28',
      files: { conversation: `/logs/${fileName}`, output: '/logs/issue-28-output.log' },
    });
    expect(await listedSizes()).toEqual([fileName, 'issue-28-output.log']);
    expect(screen.queryByText(/\d\s*(B|KB|MB)$/)).toBeNull();
    expect(fetchLogFile).not.toHaveBeenCalled();
  });

  test('shows reported legacy sizes exactly, keeping a real empty file at zero and small nonempty files above it', async () => {
    vi.mocked(fetchLogFiles).mockResolvedValueOnce({
      sessionId: 'session-28',
      logFiles: [
        { name: 'empty.log', path: '/logs/empty.log', size: 0, type: 'log' },
        { name: 'small.log', path: '/logs/small.log', size: 512, type: 'log' },
        { name: 'output.log', path: '/logs/output.log', size: 61070, type: 'log' },
        { name: 'large.log', path: '/logs/large.log', size: 3 * 1024 * 1024, type: 'log' },
      ],
    });
    expect(await listedSizes()).toEqual(['empty.log0 B', 'small.log512 B', 'output.log59.6 KB', 'large.log3.0 MB']);
  });
});
