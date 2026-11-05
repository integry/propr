import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionProfileSelector } from './ExtensionProfileSelector';
import { listExtensionProfiles } from '../../api/extensionProfilesApi';
const auth = vi.hoisted(() => ({ permitted: false }));
vi.mock('../../contexts/AuthContext', () => ({ useCurrentUser: () => null, userHasPermission: () => auth.permitted }));
vi.mock('../../api/extensionProfilesApi', () => ({ listExtensionProfiles: vi.fn(async () => ({ profiles: [{ instanceId: 'instance', profileId: 'new', revision: 2, enabled: true, name: 'Current profile' }] })) }));
const selection = { instanceId: 'instance', profileId: 'old', revision: 1 };
afterEach(() => { cleanup(); auth.permitted = false; });
describe('extension profile selection after demotion', () => {
  it('hides the optional selector when no enabled profiles exist', async () => {
    auth.permitted = true;
    vi.mocked(listExtensionProfiles).mockResolvedValueOnce({ instanceId: 'instance', profiles: [] });
    render(<ExtensionProfileSelector value={null} onChange={vi.fn()} />);
    await act(async () => {});
    expect(listExtensionProfiles).toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/administrator access/i)).toBeNull();
  });
  it('does not show a permission warning for an unused unavailable catalog', async () => {
    auth.permitted = true;
    vi.mocked(listExtensionProfiles).mockRejectedValueOnce(new Error('network unavailable'));
    render(<ExtensionProfileSelector value={null} onChange={vi.fn()} />);
    await act(async () => {});
    expect(listExtensionProfiles).toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('lets a saved selection be cleared without claiming an access denial', async () => {
    auth.permitted = true;
    vi.mocked(listExtensionProfiles).mockRejectedValueOnce(new Error('network unavailable'));
    const onChange = vi.fn();
    render(<ExtensionProfileSelector value={selection} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('could not be loaded'));
    expect(screen.queryByText(/administrator access/i)).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
  it('allows clearing a stored revision without offering profiles to members', () => {
    const onChange = vi.fn(); render(<ExtensionProfileSelector value={selection} onChange={onChange} />);
    const select = screen.getByRole('combobox'); expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: '' } }); expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.queryByText(/Current profile/)).toBeNull();
  });
  it('honors disabled state and hides an empty member selection', () => {
    const view = render(<ExtensionProfileSelector value={selection} disabled onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeDisabled();
    view.rerender(<ExtensionProfileSelector value={null} onChange={vi.fn()} />);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it('removes cached choices immediately when permission is lost', async () => {
    auth.permitted = true; const onChange = vi.fn();
    const view = render(<ExtensionProfileSelector value={selection} onChange={onChange} />);
    await waitFor(() => expect(screen.getByText(/Current profile/)).toBeInTheDocument());
    auth.permitted = false; view.rerender(<ExtensionProfileSelector value={selection} onChange={onChange} />);
    expect(screen.queryByText(/Current profile/)).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
