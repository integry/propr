import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../api/proprTypes';
import Layout from '../../components/Layout';
import AccessManagementPage from '../AccessManagementPage';
import SettingsPage from './index';

// The read-only demo identity as GET /api/auth/user returns it in demo mode.
const { demoUser, stub } = vi.hoisted(() => ({ demoUser: {
  id: 'propr-demo',
  login: 'propr-demo',
  username: 'propr-demo',
  displayName: 'propr-demo',
  email: null,
  avatarUrl: null,
  role: 'member',
  permissions: ['instance.manage_agents', 'instance.manage_members', 'instance.manage_runtime', 'instance.manage_settings'],
  authorizationSource: 'demo',
} satisfies CurrentUser,
stub: (name: string) => ({ default: () => name, [name]: () => name }) }));

vi.mock('../../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: true, isLoading: false }) }));
vi.mock('../../contexts/AuthContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../contexts/AuthContext')>(),
  useCurrentUser: () => demoUser,
}));
vi.mock('../../desktop/DesktopContext', () => ({ useDesktop: () => null }));
vi.mock('./useSettingsState', () => ({
  useSettingsState: () => ({ loading: false, saveStatus: 'idle', globalError: null, settings: {}, triggerSettingsSave: vi.fn() }),
}));

vi.mock('./UsageTipsSettingsSection', () => stub('UsageTipsSettingsSection'));
vi.mock('./WorkflowSettingsSection', () => stub('WorkflowSettingsSection'));
vi.mock('./UltrafixSettingsSection', () => stub('UltrafixSettingsSection'));
vi.mock('./AgentWatchdogSettingsSection', () => stub('AgentWatchdogSettingsSection'));
vi.mock('./AgentNetworkSettingsSection', () => stub('AgentNetworkSettingsSection'));
vi.mock('./AIModelSelectionSection', () => stub('AIModelSelectionSection'));
vi.mock('./PrLabelSection', () => stub('PrLabelSection'));
vi.mock('./TagListSection', () => stub('TagListSection'));
vi.mock('./KnowledgeBaseSection', () => stub('KnowledgeBaseSection'));
vi.mock('./AgentTankSection', () => stub('AgentTankSection'));
vi.mock('./NotificationSettingsSection', () => stub('NotificationSettingsSection'));
vi.mock('./DesktopNotificationSettingsSection', () => stub('DesktopNotificationSettingsSection'));
vi.mock('./VoiceSettingsSection', () => stub('VoiceSettingsSection'));
vi.mock('./ExperimentalSettingsSection', () => stub('ExperimentalSettingsSection'));
vi.mock('./McpServerSection', () => stub('McpServerSection'));
vi.mock('./settingsDataSections', () => ({ agentExtensionSections: () => [], settingsDataSections: () => [] }));

vi.mock('../../api/instanceMembersApi', () => ({
  getInstanceMembers: async () => ({ bootstrapAdmins: [], members: [{
    githubUserId: '1001', githubUsername: 'demo-operator', role: 'admin', source: 'local',
    createdByUserId: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }] }),
  getInstanceRoleAudit: async () => [],
}));
vi.mock('../../api/triggerWhitelistApi', () => ({ getTriggerWhitelist: async () => [] }));
vi.mock('../../api/proprApi', () => ({ logout: vi.fn() }));
vi.mock('../../hooks/useDynamicFavicon', () => ({ useDynamicFavicon: vi.fn() }));
vi.mock('../../hooks/useSystemReadiness', () => ({
  useSystemReadiness: () => ({ hasAgents: true, hasRepos: true, hasTasks: true }),
}));
vi.mock('../../components/ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('../../contexts/NotificationCenterContext', () => ({ useNotificationCenter: () => ({ unreadCount: null }) }));
vi.mock('../../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: true,
    subscribeToQueueStats: vi.fn(),
    unsubscribeFromQueueStats: vi.fn(),
    subscribeToIndexingUpdates: vi.fn(),
    unsubscribeFromIndexingUpdates: vi.fn(),
    onQueueStatsUpdate: () => vi.fn(),
    onIndexingUpdate: () => vi.fn(),
    onDraftUpdate: () => vi.fn(),
  }),
}));
vi.mock('../../components/GlobalHeader', () => ({ default: () => null }));
vi.mock('../../components/AgentTankSidebar', () => ({ default: () => null }));
vi.mock('../../components/ConnectPlusBanner', () => ({ ConnectCapacityBanner: () => null }));

describe('demo viewer navigation', () => {
  it('renders every Settings category for the read-only demo user', () => {
    render(<MemoryRouter initialEntries={['/settings']}><SettingsPage /></MemoryRouter>);

    const categories = within(screen.getByRole('tablist', { name: 'Settings categories' })).getAllByRole('tab');
    expect(categories.map(tab => tab.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('General'),
      expect.stringContaining('AI Models & Reasoning'),
      expect.stringContaining('Workflow & PR Rules'),
      expect.stringContaining('Integrations & MCP'),
      expect.stringContaining('Notifications'),
    ]));
    expect(screen.getByText('Demo mode is read-only. Settings can be inspected but not saved.')).toBeInTheDocument();
  });

  it('shows the Access entry and administrator areas in the sidebar', () => {
    render(<MemoryRouter><Layout><div>Page</div></Layout></MemoryRouter>);

    expect(screen.getByRole('link', { name: /Access/ })).toHaveAttribute('href', '/admin/members');
    expect(screen.getByRole('link', { name: /Inbox/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Goals/ })).toBeInTheDocument();
  });

  it('opens the Access page read-only for the demo user', async () => {
    render(<MemoryRouter><AccessManagementPage /></MemoryRouter>);

    expect(await screen.findByText('@demo-operator')).toBeInTheDocument();
    expect(screen.getByText('Demo mode is read-only. Instance access can be inspected but not changed.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('GitHub username')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Add user/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Role for demo-operator' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove demo-operator' })).toBeDisabled();
  });
});
