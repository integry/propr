import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopTitleBar } from './DesktopTitleBar';
import type { DesktopAdapters, DesktopConnectionResult, DesktopProfile } from './types';

export const localProfile: DesktopProfile = {
  id: 'local',
  name: 'This computer',
  baseUrl: 'http://127.0.0.1:3000',
  kind: 'local',
};

export const remoteProfile: DesktopProfile = {
  id: 'remote',
  name: 'Team server',
  baseUrl: 'https://propr.example.com',
  kind: 'remote',
};

export const adaptersFor = (
  profiles: DesktopProfile[] = [],
  activeId: string | null = null,
  probe: (profile: DesktopProfile) => Promise<DesktopConnectionResult> = async () => ({ status: 'ready', version: '0.8.15' })
): DesktopAdapters => ({
  platform: 'linux',
  app: { onDeepLink: () => () => undefined },
  profiles: {
    list: vi.fn(async () => profiles),
    save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    getActiveId: vi.fn(async () => activeId),
    setActiveId: vi.fn(async () => undefined),
  },
  discovery: { supported: true, discover: vi.fn(async () => []) },
  authentication: { authenticate: vi.fn(async () => undefined) },
  externalBrowser: { open: vi.fn(async () => undefined) },
  localSetup: { supported: true, setup: vi.fn(async () => localProfile) },
  connection: { probe: vi.fn(probe) },
});

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

export const renderConnectedExperience = (adapters: DesktopAdapters, content?: string) => render(
  <DesktopExperience adapters={adapters}>
    <DesktopTitleBar />
    {content && <div>{content}</div>}
  </DesktopExperience>
);
