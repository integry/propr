import { startTransition, Suspense, useLayoutEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopInstanceSelector } from './DesktopInstanceSelector';
import { adaptersFor, deferred, localProfile } from './DesktopExperience.testSupport';
import type { ExperienceState } from './desktopExperienceState';
import { useDesktopNativeCommands } from './useDesktopNativeCommands';
import type { DesktopConnectionResult } from './types';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

const OpenManagerAtConnectedCommit = () => {
  useLayoutEffect(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'I', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
  }, []);
  return <><DesktopInstanceSelector /><div>Connected app</div></>;
};

const neverSettles = new Promise<void>(() => undefined);
const shortcutApp = { onDeepLink: () => () => undefined };

const ShortcutDuringSupersededRender = ({
  onReconnect,
  onSupersededRender,
}: {
  onReconnect(profile: typeof localProfile): Promise<void>;
  onSupersededRender(): void;
}) => {
  const [state, setState] = useState<ExperienceState>({
    phase: 'connected',
    profile: localProfile,
    result: { status: 'ready' },
  });
  useDesktopNativeCommands({
    app: shortcutApp,
    state,
    instanceChooserBlocked: false,
    onManageInstances: () => undefined,
    onConnectInstance: () => undefined,
    onDiagnostics: () => undefined,
    onChooseInstances: () => undefined,
    onReconnect,
  });

  if (state.phase === 'connecting') {
    onSupersededRender();
    throw neverSettles;
  }
  return (
    <button type="button" onClick={() => startTransition(() => {
      setState({ phase: 'connecting', profile: localProfile });
    })}>
      Start superseded render
    </button>
  );
};

describe('DesktopExperience shortcut readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles the management shortcut in the commit that makes a delayed connection ready', async () => {
    const pendingProbe = deferred<DesktopConnectionResult>();
    const adapters = adaptersFor([localProfile], localProfile.id, () => pendingProbe.promise);
    render(
      <DesktopExperience adapters={adapters}>
        <OpenManagerAtConnectedCommit />
      </DesktopExperience>,
    );

    expect(await screen.findByRole('heading', { name: 'Connecting to This computer' })).toBeInTheDocument();
    await act(async () => { pendingProbe.resolve({ status: 'ready', version: '0.8.15' }); });

    expect(await screen.findByRole('dialog', { name: 'Manage instances' })).toBeInTheDocument();
  });

  it('uses committed shortcut state while a superseded render is suspended', () => {
    const onReconnect = vi.fn(async () => undefined);
    const onSupersededRender = vi.fn();
    render(
      <Suspense fallback={<div>Superseded state</div>}>
        <ShortcutDuringSupersededRender
          onReconnect={onReconnect}
          onSupersededRender={onSupersededRender}
        />
      </Suspense>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start superseded render' }));
    expect(onSupersededRender).toHaveBeenCalledOnce();
    expect(screen.queryByText('Superseded state')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'R', ctrlKey: true, shiftKey: true });

    expect(onReconnect).toHaveBeenCalledWith(localProfile);
  });
});
