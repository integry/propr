import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { McpAdminResponse } from '../../api/adminMcpApi';

const api = vi.hoisted(() => ({
  getMcpAdminSettings: vi.fn(),
  updateMcpAdminSettings: vi.fn(),
  revokeAllMcpConnections: vi.fn(),
}));

vi.mock('../../api/adminMcpApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/adminMcpApi')>(),
  ...api,
}));
vi.mock('../../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));

import McpServerSection from './McpServerSection';

function tunnelResponse(overrides: Partial<McpAdminResponse['status']> = {}, connectEnabled = true): McpAdminResponse {
  return {
    status: {
      enabled: connectEnabled,
      tunnelMode: true,
      connectEnabled,
      origin: 'https://t-abc.propr.dev',
      resource: 'https://t-abc.propr.dev/api/mcp',
      connectResource: 'https://mcp.propr.dev/mcp',
      connectAvailable: true,
      connectMcp: 'registered',
      scopeCeiling: ['read', 'plan', 'review'],
      ...overrides,
    },
    settings: { enabled: false, scopeCeiling: ['read', 'plan', 'review'], connectEnabled },
    scopes: ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'deploy', 'manage'],
  };
}

describe('McpServerSection in hosted UI tunnel mode', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('shows the Connect toggle, registration status and the public Connect URL', async () => {
    api.getMcpAdminSettings.mockResolvedValue(tunnelResponse());
    render(<McpServerSection />);

    const toggle = await screen.findByLabelText('Allow MCP clients through ProPR Connect');
    expect(toggle).toBeChecked();
    expect(screen.queryByLabelText('Enable MCP server')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    expect(screen.getByText('https://mcp.propr.dev/mcp')).toBeInTheDocument();
    expect(screen.queryByText('View connected apps →')).toBeNull();
  });

  test('turning the toggle off saves connectEnabled=false', async () => {
    api.getMcpAdminSettings.mockResolvedValue(tunnelResponse());
    api.updateMcpAdminSettings.mockResolvedValue({ status: tunnelResponse({ enabled: false, connectEnabled: false, connectMcp: 'disabled' }, false).status });
    render(<McpServerSection />);

    fireEvent.click(await screen.findByLabelText('Allow MCP clients through ProPR Connect'));

    await waitFor(() => expect(api.updateMcpAdminSettings).toHaveBeenCalledWith({ connectEnabled: false }));
    await waitFor(() => expect(screen.getByLabelText('Allow MCP clients through ProPR Connect')).not.toBeChecked());
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Disabled');
  });

  test('reports a registration failure and a missing key without secrets', async () => {
    api.getMcpAdminSettings.mockResolvedValue(tunnelResponse({ enabled: false, connectMcp: 'failed:KEY_MISSING', setupError: 'KEY_MISSING' }));
    render(<McpServerSection />);

    expect(await screen.findByText('Setup required')).toBeInTheDocument();
    expect(screen.getByText(/persisted MCP encryption key is missing or changed/)).toBeInTheDocument();
  });
});
