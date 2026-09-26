import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, setDesktopConnectionScope } from '../../api/apiClient';
import type { CurrentUser } from '../../api/proprTypes';
import { AuthProvider } from '../../contexts/AuthContext';
import * as runtimeMode from '../../config/runtimeMode';
import { browserVoicePreferenceKey } from '../../voice/voicePreferenceKey';
import SettingsNavigation from './SettingsNavigation';
import VoiceSettingsSection from './VoiceSettingsSection';

const user = { id: 'account-a', username: 'example', permissions: [] } as unknown as CurrentUser;
const storageKey = () => browserVoicePreferenceKey(API_BASE_URL || window.location.origin, user.id);
let activeUser: CurrentUser | null;

function Wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider user={activeUser}>{children}</AuthProvider>;
}

beforeEach(() => {
  localStorage.clear();
  activeUser = user;
  vi.spyOn(runtimeMode, 'isDesktopRuntime').mockReturnValue(false);
  setDesktopConnectionScope(null);
});
afterEach(() => vi.restoreAllMocks());

describe('VoiceSettingsSection', () => {
  it('offers an experimental opt-in that is off until the user chooses it', () => {
    render(<VoiceSettingsSection />, { wrapper: Wrapper });

    expect(screen.getByRole('heading', { name: 'Voice briefings · Experimental' })).toBeInTheDocument();
    const toggle = screen.getByRole('checkbox', { name: 'Enable voice briefings' });
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/Off by default in every runtime/);
    expect(localStorage.getItem(storageKey())).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem(storageKey())).toBe('true');

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem(storageKey())).toBe('false');
  });

  it('restores a stored opt-in for the signed-in account on a later load', () => {
    localStorage.setItem(storageKey(), 'true');
    render(<VoiceSettingsSection />, { wrapper: Wrapper });
    expect(screen.getByRole('checkbox', { name: 'Enable voice briefings' })).toBeChecked();
  });

  it('cannot be chosen before the instance has a signed-in account', () => {
    activeUser = null;
    render(<VoiceSettingsSection />, { wrapper: Wrapper });

    expect(screen.getByRole('checkbox', { name: 'Enable voice briefings' })).toBeDisabled();
    expect(screen.getByText('Sign in to this instance to choose this preference.')).toBeInTheDocument();
  });

  it('is surfaced by a settings search for voice', () => {
    render(
      <SettingsNavigation sections={[{
        id: 'voice-briefings',
        category: 'integrations',
        searchText: 'voice briefings experimental microphone speech briefing catch me up enable disable desktop browser',
        content: <VoiceSettingsSection />,
      }]} />,
      { wrapper: Wrapper },
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'voice' } });
    expect(screen.getByRole('checkbox', { name: 'Enable voice briefings' })).toBeInTheDocument();
  });
});
