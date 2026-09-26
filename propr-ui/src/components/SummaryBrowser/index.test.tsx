import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  DirectoryTreeResponse,
  IndexingStatusResponse,
  SummaryEntry,
} from '../../api/summaryApi';
import SummaryBrowser from './index';
import { getDirectoryTree, getIndexingStatus } from '../../api/summaryApi';

vi.mock('../../api/summaryApi', () => ({
  getDirectoryTree: vi.fn(),
  getIndexingStatus: vi.fn(),
}));

const mockedGetDirectoryTree = vi.mocked(getDirectoryTree);
const mockedGetIndexingStatus = vi.mocked(getIndexingStatus);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function status(repository: string, fileCount = 1): IndexingStatusResponse {
  return {
    repository,
    indexed: true,
    indexingStatus: 'completed',
    totalEntries: fileCount,
    fileCount,
    directoryCount: 0,
    lastIndexedAt: null,
    lastIndexedHash: null,
    lastIndexedCommitMessage: null,
  };
}

function tree(repository: string, entries: SummaryEntry[]): DirectoryTreeResponse {
  return { repository, path: '/', entries };
}

function file(name: string, summary: string): SummaryEntry {
  return { name, path: name, entryType: 'file', summary, hasChildren: false };
}

afterEach(() => vi.clearAllMocks());

describe('SummaryBrowser scope isolation', () => {
  test('passes the resolved branch through initial requests and GitHub links', async () => {
    mockedGetIndexingStatus.mockResolvedValue(status('integry/propr'));
    mockedGetDirectoryTree.mockResolvedValue(tree('integry/propr', [
      file('README.md', 'Branch-specific README'),
    ]));

    render(<SummaryBrowser owner="integry" repo="propr" branch="release/2026 Q1" />);

    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument());
    expect(mockedGetIndexingStatus).toHaveBeenCalledWith('integry', 'propr', 'release/2026 Q1');
    expect(mockedGetDirectoryTree).toHaveBeenCalledWith('integry', 'propr', '', 'release/2026 Q1');

    fireEvent.click(screen.getByText('README.md'));
    await waitFor(() => expect(screen.getByTitle('Open on GitHub')).toHaveAttribute(
      'href',
      'https://github.com/integry/propr/blob/release%2F2026%20Q1/README.md',
    ));
  });

  test('ignores late status and root responses after switching repository and branch', async () => {
    const oldStatus = deferred<IndexingStatusResponse>();
    const oldRoot = deferred<DirectoryTreeResponse>();
    const newStatus = deferred<IndexingStatusResponse>();
    const newRoot = deferred<DirectoryTreeResponse>();

    mockedGetIndexingStatus.mockImplementation((owner) => owner === 'old'
      ? oldStatus.promise
      : newStatus.promise);
    mockedGetDirectoryTree.mockImplementation((owner) => owner === 'old'
      ? oldRoot.promise
      : newRoot.promise);

    const view = render(<SummaryBrowser owner="old" repo="repo" branch="main" />);
    await waitFor(() => expect(mockedGetIndexingStatus).toHaveBeenCalledWith('old', 'repo', 'main'));

    await act(async () => { oldStatus.resolve(status('old/repo')); });
    await waitFor(() => expect(mockedGetDirectoryTree).toHaveBeenCalledWith('old', 'repo', '', 'main'));

    view.rerender(<SummaryBrowser owner="new" repo="repo" branch="develop" />);
    await waitFor(() => expect(mockedGetIndexingStatus).toHaveBeenCalledWith('new', 'repo', 'develop'));

    await act(async () => {
      newStatus.resolve(status('new/repo', 2));
      newRoot.resolve(tree('new/repo', [file('new.ts', 'New summary')]));
    });
    await waitFor(() => expect(screen.getByText('new.ts')).toBeInTheDocument());

    await act(async () => { oldRoot.resolve(tree('old/repo', [file('old.ts', 'Old summary')])); });
    expect(screen.queryByText('old.ts')).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('2 files');
  });

  test('clears selection and ignores late expanded-child responses on scope changes', async () => {
    const oldChild = deferred<DirectoryTreeResponse>();
    const newRoot = deferred<DirectoryTreeResponse>();

    mockedGetIndexingStatus.mockImplementation(async (owner) => status(`${owner}/repo`));
    mockedGetDirectoryTree.mockImplementation((owner, _repo, path) => {
      if (owner === 'old' && path === '') {
        return Promise.resolve(tree('old/repo', [{
          name: 'src', path: 'src', entryType: 'directory', summary: 'Old directory', hasChildren: true,
        }]));
      }
      if (owner === 'old') return oldChild.promise;
      return newRoot.promise;
    });

    const view = render(<SummaryBrowser owner="old" repo="repo" branch="main" />);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(mockedGetDirectoryTree).toHaveBeenCalledWith('old', 'repo', 'src', 'main'));

    view.rerender(<SummaryBrowser owner="new" repo="repo" branch="release" />);
    await waitFor(() => expect(mockedGetIndexingStatus).toHaveBeenCalledWith('new', 'repo', 'release'));
    await act(async () => { newRoot.resolve(tree('new/repo', [file('new.ts', 'New summary')])); });
    await waitFor(() => expect(screen.getByText('new.ts')).toBeInTheDocument());

    await act(async () => { oldChild.resolve(tree('old/repo', [file('old-child.ts', 'Old child')])); });
    expect(screen.queryByText('old-child.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('Old directory')).not.toBeInTheDocument();
    expect(screen.getByText('Select a file or directory to view its summary')).toBeInTheDocument();
  });
});
