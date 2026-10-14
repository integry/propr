import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter, HashRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import PlanStudioPage from './PlanStudioPage';
import { useAutoDraftCreation } from '../components/TaskPlanner/useAutoDraftCreation';
import { createDraft, updateDraft } from '../api/proprApi';
import type { PlannerDraft } from '../api/plannerApi';
import { isTrustedRendererUrl } from '../../../apps/desktop/src/security';
import { registerIpcHandlers } from '../../../apps/desktop/src/ipc';
import { configureDesktopSessionSecurity } from '../../../apps/desktop/src/session-security';
import { IPC_CHANNELS } from '../../../apps/desktop/src/shared/contract';
import type { Session } from 'electron';

vi.mock('../api/proprApi', () => ({ createDraft: vi.fn(), updateDraft: vi.fn(), uploadAttachment: vi.fn() }));
vi.mock('../hooks/useDraft', () => ({
  useDraft: (_id: string, options: { initialData?: PlannerDraft }) => ({
    draft: options.initialData, loading: false, error: null, refetch: vi.fn(), activateGenerationRun: vi.fn(),
  }),
}));
// Keep the production creation hook and page callback; isolate unrelated setup loaders.
vi.mock('../components/TaskPlanner/SetupWizard', () => ({
  default: function Composer({ draft, onDraftCreatedInPlace }: {
    draft?: PlannerDraft; onDraftCreatedInPlace: (draft: PlannerDraft) => void;
  }) {
    const [prompt, setPrompt] = useState('');
    const creation = useAutoDraftCreation({
      isNewMode: !draft, selectedRepo: 'integry/propr', resolvedBaseBranch: 'main',
      prompt, localFiles: [], onDraftCreatedInPlace, navigate: vi.fn(),
    });
    return <><textarea aria-label="Prompt" value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button onClick={() => void creation.ensureDraftCreated()}>Ensure draft</button>
      <output>{draft?.draft_id}</output></>;
  },
}));

const renderer = 'propr-app://renderer/renderer.html';
const reconfigureUrl = (url: string) => {
  (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({ url });
};

afterEach(() => {
  reconfigureUrl('http://localhost:3000/');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function nativeBoundary() {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const navigation = vi.fn();
  const notifications = vi.fn(() => ({ enabled: true }));
  const ipc = registerIpcHandlers({
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), removeHandler: vi.fn() },
    credentials: {}, logger: { log: vi.fn() },
    notifications: { get: notifications },
    packagedRendererUrl: renderer, onNativeNavigationState: navigation,
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
  let beforeRequest: Parameters<Session['webRequest']['onBeforeSendHeaders']>[0];
  const mainFrame = { detached: false, parent: null, get url() { return window.location.href; } };
  const mainRenderer = { id: 1, mainFrame, isDestroyed: () => false, getURL: () => window.location.href };
  const prepareRequestAsync = vi.fn(async (_url, _headers, options) => ({ cancel: !options.rendererOwned }));
  const security = configureDesktopSessionSecurity({
    contentSecurityPolicy: () => "default-src 'self'",
    credentials: { prepareRequestAsync },
    desktopSession: {
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
      webRequest: { onBeforeSendHeaders: (handler: typeof beforeRequest) => { beforeRequest = handler; }, onHeadersReceived: vi.fn() },
    },
    getMainRenderer: () => mainRenderer,
    isTrustedRendererUrl: (url: string) => isTrustedRendererUrl(url, undefined, renderer),
  } as unknown as Parameters<typeof configureDesktopSessionSecurity>[0]);
  return {
    async api() {
      const decision = await new Promise<{ cancel?: boolean }>(resolve => beforeRequest!({
        url: 'https://instance.example/api/planner/generate', method: 'POST',
        requestHeaders: {}, resourceType: 'xhr', webContentsId: 1, webContents: mainRenderer, frame: mainFrame,
      } as unknown as Parameters<NonNullable<typeof beforeRequest>>[0], resolve));
      expect(decision.cancel).toBe(false);
    },
    async ipc() {
      const event = { senderFrame: { url: window.location.href } };
      await handlers.get(IPC_CHANNELS.nativeNavigationState)!(event, { connectionScope: null, canManageInstances: true, canGoBack: false, canGoForward: false });
      await handlers.get(IPC_CHANNELS.notificationsGet)!(event, { profileId: 'test', transportScope: 'abcdefghijklmnopqrstuv', userId: 'test' });
      expect(navigation).toHaveBeenCalledOnce();
      expect(notifications).toHaveBeenCalledOnce();
    },
    dispose() { ipc.dispose(); security.dispose(); },
  };
}

it.each([true, false])('auto-saves in place, preserving the prompt and focus (desktop=%s)', async desktop => {
  vi.stubGlobal('__PROPR_DESKTOP__', desktop);
  vi.useFakeTimers();
  reconfigureUrl(desktop ? `${renderer}#/studio/new` : 'https://app.example/studio/new');
  vi.mocked(createDraft).mockReset().mockResolvedValue({
    draft_id: 'draft-1', repository: 'integry/propr', initial_prompt: 'Document setup',
    status: 'draft', attachments: [], created_at: '2026-10-14T00:00:00Z',
  });
  // The draft exists even if the setup-save acknowledgement fails.
  vi.mocked(updateDraft).mockRejectedValueOnce(new Error('Acknowledgement lost'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const boundary = desktop ? nativeBoundary() : null;
  const Router = desktop ? HashRouter : BrowserRouter;
  render(<Router><Routes><Route path="/studio/new" element={<PlanStudioPage isNew />} /></Routes></Router>);
  const prompt = screen.getByRole('textbox', { name: 'Prompt' });
  prompt.focus();
  fireEvent.change(prompt, { target: { value: 'Document setup' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText('draft-1')).toBeInTheDocument();
  expect(window.location.href).toBe(desktop ? `${renderer}#/studio/draft-1` : 'https://app.example/studio/draft-1');
  expect(screen.getByRole('textbox')).toBe(prompt);
  expect(prompt).toHaveFocus();
  fireEvent.change(prompt, { target: { value: 'Document setup and troubleshooting' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ensure draft' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(prompt).toHaveValue('Document setup and troubleshooting');
  expect(createDraft).toHaveBeenCalledOnce();
  await boundary?.api();
  await boundary?.ipc();
  boundary?.dispose();
});
