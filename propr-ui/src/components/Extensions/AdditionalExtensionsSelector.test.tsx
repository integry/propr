import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryRevision } from '@propr/shared';
import { AdditionalExtensionsSelector } from './AdditionalExtensionsSelector';
import { getExtensionLibrary } from '../../api/extensionProfilesApi';
const auth = vi.hoisted(() => ({ permitted: false }));
vi.mock('../../contexts/AuthContext', () => ({ useCurrentUser: () => null, userHasPermission: () => auth.permitted }));
const bundleId = '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e';
const otherBundle = '9c1f3d55-5b1e-4f86-9d4f-3b2a5e1c7a10';
const limits = { repositories: [], agents: [], autoApply: false };
const library = {
  instanceId: 'instance', revision: 4, version: 1, createdAt: 0, updatedAt: 0, auditActor: '1', secrets: {},
  servers: [
    { kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read', authentication: 'none', ...limits },
    { kind: 'https', name: 'tracker', url: 'https://tracker.example.com/mcp', enabled: true, tools: [], capability: 'write', authentication: 'none', ...limits, autoApply: true },
    { kind: 'https', name: 'other-repo', url: 'https://other.example.com/mcp', enabled: true, tools: [], capability: 'read', authentication: 'none', ...limits, repositories: ['example/other'] },
    { kind: 'https', name: 'codex-only', url: 'https://codex.example.com/mcp', enabled: true, tools: [], capability: 'read', authentication: 'none', ...limits, agents: ['codex-main'] },
  ],
  skills: [{ bundleId, enabled: false, ...limits }, { bundleId: otherBundle, enabled: true, ...limits }],
  skillBundles: [
    { id: bundleId, instanceId: 'instance', name: 'Documentation review', digest: 'd'.repeat(64), files: 1, bytes: 10, source: { kind: 'archive', filename: 'review.tar' }, requirements: [], createdAt: 0, auditActor: '1' },
    { id: otherBundle, instanceId: 'instance', name: 'Release notes', digest: 'e'.repeat(64), files: 1, bytes: 10, source: { kind: 'archive', filename: 'notes.tar' }, requirements: [], createdAt: 0, auditActor: '1' },
  ],
} as unknown as ExtensionLibraryRevision;
vi.mock('../../api/extensionProfilesApi', () => ({ getExtensionLibrary: vi.fn() }));
const loaded = () => vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library });
const empty = { servers: [], skills: [] };
const target = { repositories: ['example/docs'], agentAlias: 'claude-main', agentType: 'claude' };
afterEach(() => { cleanup(); auth.permitted = false; vi.mocked(getExtensionLibrary).mockReset(); });
describe('AdditionalExtensionsSelector', () => {
  it('offers matching library items in two lists, marks automatic items, and reports the choice', async () => {
    auth.permitted = true; loaded(); const onChange = vi.fn();
    render(<AdditionalExtensionsSelector value={empty} target={target} onChange={onChange} />);
    await waitFor(() => expect(screen.getByLabelText(/^docs/)).toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Additional extensions' })).toBeInTheDocument();
    expect(screen.getByText('MCP servers')).toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByLabelText(/tracker/)).toHaveAccessibleName(/already applies automatically/);
    // Items outside the automation's repositories or agent, and switched-off items, are not offered.
    expect(screen.queryByLabelText(/other-repo/)).toBeNull();
    expect(screen.queryByLabelText(/codex-only/)).toBeNull();
    expect(screen.queryByLabelText(/Documentation review/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/^docs/));
    expect(onChange).toHaveBeenLastCalledWith({ servers: ['docs'], skills: [] });
    fireEvent.click(screen.getByLabelText(/Release notes/));
    expect(onChange).toHaveBeenLastCalledWith({ servers: [], skills: [otherBundle] });
  });
  it('shows selected items that are missing, switched off or no longer match as skipped, and keeps them removable', async () => {
    auth.permitted = true; loaded(); const onChange = vi.fn();
    render(<AdditionalExtensionsSelector value={{ servers: ['docs', 'retired', 'other-repo', 'codex-only'], skills: [bundleId] }} target={target} onChange={onChange} />);
    await waitFor(() => expect(screen.getByLabelText(/retired/)).toHaveAccessibleName(/skipped: no longer in the library/));
    expect(screen.getByLabelText(/other-repo/)).toHaveAccessibleName(/skipped: limited to other repositories/);
    expect(screen.getByLabelText(/codex-only/)).toHaveAccessibleName(/skipped: limited to other agents/);
    expect(screen.getByLabelText(/Documentation review/)).toHaveAccessibleName(/skipped: switched off in the library/);
    expect(screen.getByLabelText(/^docs/)).toBeChecked();
    fireEvent.click(screen.getByLabelText(/retired/));
    expect(onChange).toHaveBeenLastCalledWith({ servers: ['docs', 'other-repo', 'codex-only'], skills: [bundleId] });
  });
  it('does not hold agent limits against an automation whose agent is unknown', async () => {
    auth.permitted = true; loaded();
    render(<AdditionalExtensionsSelector value={empty} target={{ repositories: ['example/docs'] }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/codex-only/)).toBeInTheDocument());
  });
  it('hides when the library is empty and nothing is added', async () => {
    auth.permitted = true;
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library: { ...library, servers: [], skills: [], skillBundles: [] } });
    const view = render(<AdditionalExtensionsSelector value={empty} target={target} onChange={vi.fn()} />);
    await act(async () => {});
    expect(getExtensionLibrary).toHaveBeenCalled();
    expect(view.container).toBeEmptyDOMElement();
  });
  it('keeps saved items removable when the library cannot be loaded', async () => {
    auth.permitted = true; vi.mocked(getExtensionLibrary).mockRejectedValue(new Error('network unavailable')); const onChange = vi.fn();
    render(<AdditionalExtensionsSelector value={{ servers: ['docs'], skills: [] }} target={target} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('could not be loaded'));
    fireEvent.click(screen.getByLabelText('docs'));
    expect(onChange).toHaveBeenLastCalledWith(empty);
  });
  it('does not load or offer items to members and shows saved items read-only', () => {
    const onChange = vi.fn();
    const view = render(<AdditionalExtensionsSelector value={empty} target={target} onChange={onChange} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<AdditionalExtensionsSelector value={{ servers: ['docs'], skills: [] }} target={target} onChange={onChange} />);
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(getExtensionLibrary).not.toHaveBeenCalled();
  });
  it('drops loaded choices immediately when permission is lost and honors disabled', async () => {
    auth.permitted = true; loaded();
    const view = render(<AdditionalExtensionsSelector value={{ servers: ['docs'], skills: [] }} target={target} disabled onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/tracker/)).toBeDisabled());
    auth.permitted = false; view.rerender(<AdditionalExtensionsSelector value={{ servers: ['docs'], skills: [] }} target={target} onChange={vi.fn()} />);
    expect(screen.queryByText(/tracker/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
