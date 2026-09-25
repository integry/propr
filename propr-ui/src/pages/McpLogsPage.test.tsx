import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import McpLogsPage from './McpLogsPage';
import { AuthProvider } from '../contexts/AuthContext';
import type { CurrentUser, InstancePermission } from '../api/proprTypes';
import {
  McpAccessLogPermissionError,
  getMcpAccessLogStats,
  getMcpAccessLogs,
  type McpAccessLogEntry,
  type McpAccessLogPagination,
} from '../api/adminMcpLogsApi';

vi.mock('../api/adminMcpLogsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/adminMcpLogsApi')>()),
  getMcpAccessLogs: vi.fn(),
  getMcpAccessLogStats: vi.fn(),
}));

const mockGetLogs = vi.mocked(getMcpAccessLogs);
const mockGetStats = vi.mocked(getMcpAccessLogStats);

function operator(permissions: InstancePermission[] = ['instance.manage_settings']): CurrentUser {
  return {
    id: '42',
    login: 'octocat',
    username: 'octocat',
    displayName: 'The Octocat',
    email: null,
    avatarUrl: null,
    role: 'admin',
    permissions,
    authorizationSource: 'local',
  };
}

function entry(overrides: Partial<McpAccessLogEntry> = {}): McpAccessLogEntry {
  return {
    id: 1,
    occurredAt: Date.parse('2026-09-24T10:00:00.000Z'),
    ownerId: '42',
    grantId: 'grant-1',
    clientId: 'client-a',
    clientName: 'Claude Desktop',
    membershipSource: 'local',
    kind: 'tool',
    name: 'propr_list_tasks',
    repository: 'integry/propr',
    scope: 'read',
    readOnly: true,
    status: 200,
    outcome: 'success',
    errorCode: null,
    durationMs: 120,
    resultBytes: 2048,
    operationId: null,
    protocolVersion: '2026-06-18',
    requestId: '1',
    ...overrides,
  };
}

function pagination(overrides: Partial<McpAccessLogPagination> = {}): McpAccessLogPagination {
  return { page: 1, limit: 50, offset: 0, total: 2, totalPages: 1, hasNextPage: false, hasPreviousPage: false, ...overrides };
}

const stats = {
  window: { since: 1, until: 2 },
  total: 42,
  outcomes: { success: 39, denied: 2, error: 1 },
  topTools: [{ name: 'propr_list_tasks', count: 30 }],
  topClients: [{ clientId: 'client-a', clientName: 'Claude Desktop', count: 41 }],
  topRepositories: [],
  errorCodes: [],
  durationMs: { p50: 110, p95: 940 },
};

const Location = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
};

function renderPage(route = '/mcp-logs', user: CurrentUser | null = operator()) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider user={user}>
        <McpLogsPage />
        <Location />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe('McpLogsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLogs.mockResolvedValue({ data: [entry()], pagination: pagination(), filters: {} });
    mockGetStats.mockResolvedValue({ data: stats });
  });

  it('renders the newest-first table and the window summary', async () => {
    mockGetLogs.mockResolvedValue({
      data: [
        entry({ id: 2, name: 'propr_create_task', outcome: 'denied', status: 403, errorCode: 'FORBIDDEN_REPOSITORY', durationMs: 8 }),
        entry({ id: 1 }),
      ],
      pagination: pagination(),
      filters: {},
    });
    renderPage();

    const table = within(await screen.findByRole('table'));
    expect(table.getByText('propr_create_task')).toBeInTheDocument();
    const summary = screen.getByRole('group', { name: 'MCP access summary' });
    expect(within(summary).getByText('42')).toBeInTheDocument();
    expect(within(summary).getByText('110ms')).toBeInTheDocument();
    expect(within(summary).getByText('940ms')).toBeInTheDocument();
    expect(within(summary).getByText('Claude Desktop')).toBeInTheDocument();

    // Denied and successful rows are told apart by their own outcome badge.
    expect(table.getByText('Denied')).toBeInTheDocument();
    expect(table.getByText('Success')).toBeInTheDocument();
    expect(table.getAllByText('FORBIDDEN_REPOSITORY').length).toBeGreaterThan(0);
  });

  it('renders any figure the summary omits as unavailable rather than zero', async () => {
    mockGetStats.mockResolvedValue({ data: { total: 7 } });
    renderPage();

    const summary = await screen.findByRole('group', { name: 'MCP access summary' });
    expect(within(summary).getByText('7')).toBeInTheDocument();
    expect(within(summary).queryByText('0')).not.toBeInTheDocument();
    expect(within(summary).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows a loading state before the first response', async () => {
    mockGetLogs.mockImplementation(() => new Promise(() => undefined));
    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Loading MCP access log');
    await waitFor(() => expect(mockGetLogs).toHaveBeenCalled());
  });

  it('shows an error rather than an empty log when the request fails', async () => {
    mockGetLogs.mockRejectedValue(new Error('Database unavailable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Database unavailable');
    expect(screen.queryByText(/No MCP requests/)).not.toBeInTheDocument();

    mockGetLogs.mockResolvedValue({ data: [entry()], pagination: pagination(), filters: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(within(await screen.findByRole('table')).getByText('propr_list_tasks')).toBeInTheDocument();
  });

  it('shows a distinct empty state', async () => {
    mockGetLogs.mockResolvedValue({ data: [], pagination: pagination({ total: 0, totalPages: 0 }), filters: {} });
    renderPage();

    expect(await screen.findByText(/No MCP requests recorded in this window/)).toBeInTheDocument();
  });

  it('blocks the route for a user without the instance settings permission', async () => {
    renderPage('/mcp-logs', operator(['instance.manage_agents']));

    expect(await screen.findByText('Operator access required')).toBeInTheDocument();
    expect(mockGetLogs).not.toHaveBeenCalled();
    expect(mockGetStats).not.toHaveBeenCalled();
  });

  it('reports a 403 from the API as a permission state, not an error', async () => {
    mockGetLogs.mockRejectedValue(new McpAccessLogPermissionError());
    renderPage();

    expect(await screen.findByText('Operator access required')).toBeInTheDocument();
  });

  it('composes every filter from the URL query string into one request', async () => {
    renderPage('/mcp-logs?window=7d&outcome=denied&kind=tool&name=propr_list_tasks&repository=integry%2Fpropr&client=client-a&user=42&page=2');

    await waitFor(() => expect(mockGetLogs).toHaveBeenCalled());
    const params = mockGetLogs.mock.calls[0][0]!;
    expect(params).toMatchObject({
      page: 2,
      limit: 50,
      outcome: 'denied',
      kind: 'tool',
      name: 'propr_list_tasks',
      repository: 'integry/propr',
      clientId: 'client-a',
      ownerId: '42',
    });
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(Date.now() - params.since!).toBeGreaterThanOrEqual(sevenDays);
    expect(Date.now() - params.since!).toBeLessThan(sevenDays + 60_000);

    // The window round-trips into the controls, so a shared link reopens the same view.
    expect(await screen.findByLabelText('Time window')).toHaveValue('7d');
    expect(screen.getByLabelText('Outcome')).toHaveValue('denied');
    expect(screen.getByLabelText('Repository')).toHaveValue('integry/propr');
  });

  it('writes the active filters back into the URL', async () => {
    renderPage();
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'error' } });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('outcome=error'));

    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'integry/propr' } });
    fireEvent.submit(screen.getByRole('form', { name: 'MCP log filters' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('repository=integry%2Fpropr'));
    await waitFor(() => expect(mockGetLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'error', repository: 'integry/propr', page: 1 })
    ));
  });

  it('pages through the log', async () => {
    mockGetLogs.mockResolvedValue({
      data: [entry()],
      pagination: pagination({ total: 120, totalPages: 3, hasNextPage: true }),
      filters: {},
    });
    renderPage();
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('page=2'));
    await waitFor(() => expect(mockGetLogs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });
});
