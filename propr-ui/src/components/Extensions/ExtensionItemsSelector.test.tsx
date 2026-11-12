import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryRevision } from '@propr/shared';
import { ExtensionItemsSelector } from './ExtensionItemsSelector';
import { getExtensionLibrary } from '../../api/extensionProfilesApi';
const auth = vi.hoisted(() => ({ permitted: false }));
vi.mock('../../contexts/AuthContext', () => ({ useCurrentUser: () => null, userHasPermission: () => auth.permitted }));
const bundleId = '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e';
const limits = { repositories: [], agents: [], autoApply: false };
const library = {
  instanceId: 'instance', revision: 4, version: 1, createdAt: 0, updatedAt: 0, auditActor: '1', secrets: {},
  servers: [
    { kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read', authentication: 'none', ...limits },
    { kind: 'https', name: 'tracker', url: 'https://tracker.example.com/mcp', enabled: true, tools: [], capability: 'write', authentication: 'none', ...limits, autoApply: true },
  ],
  skills: [{ bundleId, enabled: false, ...limits }],
  skillBundles: [{ id: bundleId, instanceId: 'instance', name: 'Documentation review', digest: 'd'.repeat(64), files: 1, bytes: 10, source: { kind: 'archive', filename: 'review.tar' }, requirements: [], createdAt: 0, auditActor: '1' }],
} as unknown as ExtensionLibraryRevision;
vi.mock('../../api/extensionProfilesApi', () => ({ getExtensionLibrary: vi.fn() }));
const loaded = () => vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library });
const empty = { servers: [], skills: [] };
afterEach(() => { cleanup(); auth.permitted = false; vi.mocked(getExtensionLibrary).mockReset(); });
describe('automation extension items', () => {
  it('lists library servers by name and skills by bundle name, and reports the added items', async () => {
    auth.permitted = true; loaded(); const onChange = vi.fn();
    render(<ExtensionItemsSelector value={empty} onChange={onChange} />);
    await waitFor(() => expect(screen.getByLabelText(/^docs/)).toBeInTheDocument());
    expect(screen.getByText(/on top of the library items that apply automatically/)).toBeInTheDocument();
    expect(screen.getByLabelText(/tracker/)).toHaveAccessibleName(/also applies automatically/);
    expect(screen.getByLabelText(/Documentation review/)).toHaveAccessibleName(/disabled in the library/);
    fireEvent.click(screen.getByLabelText(/^docs/));
    expect(onChange).toHaveBeenLastCalledWith({ servers: ['docs'], skills: [] });
    fireEvent.click(screen.getByLabelText(/Documentation review/));
    expect(onChange).toHaveBeenLastCalledWith({ servers: [], skills: [bundleId] });
  });
  it('removes a selected item, including one no longer in the library', async () => {
    auth.permitted = true; loaded(); const onChange = vi.fn();
    render(<ExtensionItemsSelector value={{ servers: ['docs', 'retired'], skills: [] }} onChange={onChange} />);
    await waitFor(() => expect(screen.getByLabelText(/retired/)).toHaveAccessibleName(/not in the library/));
    expect(screen.getByLabelText(/^docs/)).toBeChecked();
    fireEvent.click(screen.getByLabelText(/retired/));
    expect(onChange).toHaveBeenLastCalledWith({ servers: ['docs'], skills: [] });
  });
  it('hides when the library is empty and nothing is added', async () => {
    auth.permitted = true;
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library: { ...library, servers: [], skills: [], skillBundles: [] } });
    const view = render(<ExtensionItemsSelector value={empty} onChange={vi.fn()} />);
    await act(async () => {});
    expect(getExtensionLibrary).toHaveBeenCalled();
    expect(view.container).toBeEmptyDOMElement();
  });
  it('keeps saved items removable when the library cannot be loaded', async () => {
    auth.permitted = true; vi.mocked(getExtensionLibrary).mockRejectedValue(new Error('network unavailable')); const onChange = vi.fn();
    render(<ExtensionItemsSelector value={{ servers: ['docs'], skills: [] }} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('could not be loaded'));
    fireEvent.click(screen.getByLabelText('docs'));
    expect(onChange).toHaveBeenLastCalledWith(empty);
  });
  it('does not load or offer items to members and shows saved items read-only', () => {
    const onChange = vi.fn();
    const view = render(<ExtensionItemsSelector value={empty} onChange={onChange} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<ExtensionItemsSelector value={{ servers: ['docs'], skills: [] }} onChange={onChange} />);
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(getExtensionLibrary).not.toHaveBeenCalled();
  });
  it('drops loaded choices immediately when permission is lost and honors disabled', async () => {
    auth.permitted = true; loaded();
    const view = render(<ExtensionItemsSelector value={{ servers: ['docs'], skills: [] }} disabled onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/tracker/)).toBeDisabled());
    auth.permitted = false; view.rerender(<ExtensionItemsSelector value={{ servers: ['docs'], skills: [] }} onChange={vi.fn()} />);
    expect(screen.queryByText(/tracker/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
