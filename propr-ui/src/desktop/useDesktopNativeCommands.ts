import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { DESKTOP_NAVIGATION_EVENT } from './DesktopNativeNavigationObserver';
import { NativeNavigationHistory } from './nativeNavigationHistory';
import { navigateToUiPath } from '../config/runtimeMode';
import type {
  DesktopNativeCommand,
  DesktopNativeCommandDelivery,
} from '../../../apps/desktop/src/shared/contract';
import type { ExperienceState } from './desktopExperienceState';
import type { DesktopAdapters, DesktopProfile } from './types';

export const DESKTOP_UI_COMMAND_EVENT = 'propr:desktop-ui-command';

interface DesktopNativeCommandOptions {
  app: DesktopAdapters['app'];
  state: ExperienceState;
  instanceChooserBlocked: boolean;
  onNavigate?(): void;
  onManageInstances(): void;
  onChooseInstances(): void;
  onConnectInstance(): void;
  onDiagnostics(): void;
  onReconnect(profile: DesktopProfile): Promise<void>;
}

const commandPaths: Record<Exclude<DesktopNativeCommand, 'manage-instances' | 'connect-instance' | 'diagnostics' | 'search' | 'toggle-sidebar' | 'quit' | 'back' | 'forward'>, string> = {
  'new-plan': '/studio/new',
  'new-task': '/tasks/new',
  dashboard: '/',
  goals: '/goals',
  repositories: '/repositories',
  'llm-logs': '/llm-logs',
  settings: '/settings',
  tasks: '/tasks',
  plans: '/plans',
  inbox: '/inbox',
  'notification-settings': '/settings?tab=notifications',
};

const confirmPlanStudioDiscard = (): boolean => {
  const current = new URL(
    window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash || '/',
    'https://desktop.propr.invalid',
  ).pathname;
  return !current.startsWith('/studio/')
    || window.confirm('Leave this plan? Any unsaved changes will be lost.');
};

const matchesConnectedScope = (
  connectionScope: DesktopNativeCommandDelivery['connectionScope'],
  state: Extract<ExperienceState, { phase: 'connected' }>,
): boolean => Boolean(connectionScope
  && state.profile.id === connectionScope.profileId
  && state.result.profileId === connectionScope.profileId
  && state.result.transportScope === connectionScope.transportScope);

const readDesktopPath = (): string => window.location.hash.slice(1) || '/';

const navigateNativeCommand = (
  command: Exclude<DesktopNativeCommand, 'quit' | 'manage-instances' | 'connect-instance' | 'diagnostics' | 'search' | 'toggle-sidebar'>,
  history: NativeNavigationHistory,
  onNavigate: DesktopNativeCommandOptions['onNavigate'],
): void => {
  // Include query/hash state in history (filters and detail tabs are navigation).
  history.record(readDesktopPath());
  const direction = command === 'back' || command === 'forward' ? command : null;
  const target = command === 'back' || command === 'forward'
    ? history.target(command)
    : commandPaths[command];
  if (target === undefined) return;
  if (readDesktopPath() !== target && !confirmPlanStudioDiscard()) return;
  if (direction) history.move(direction);
  onNavigate?.();
  if (readDesktopPath() !== target) navigateToUiPath(target);
};

export const useDesktopNativeCommands = ({
  app,
  state,
  instanceChooserBlocked,
  onNavigate,
  onManageInstances,
  onChooseInstances,
  onConnectInstance,
  onDiagnostics,
  onReconnect,
}: DesktopNativeCommandOptions): void => {
  const [pendingCommand, setPendingCommand] = useState<DesktopNativeCommandDelivery | null>(null);

  const history = useRef(new NativeNavigationHistory());
  const connection = state.phase === 'connected' ? state.result : null;
  const profileId = connection?.profileId;
  const transportScope = connection?.transportScope;
  const canManageInstances = !instanceChooserBlocked
    && !['loading', 'connecting', 'authenticating'].includes(state.phase);

  useEffect(() => {
    // Every reauthentication gets a fresh transport scope, including another
    // account on the same instance. Never traverse the document's older history.
    const routes = new NativeNavigationHistory();
    history.current = routes;
    const report = () => {
      if (profileId && transportScope) routes.record(readDesktopPath());
      void app.setNativeNavigationState?.({
        connectionScope: profileId && transportScope ? { profileId, transportScope } : null,
        canManageInstances, ...routes.state,
      }).catch(() => undefined);
    };
    report();
    window.addEventListener('hashchange', report);
    window.addEventListener(DESKTOP_NAVIGATION_EVENT, report);
    return () => {
      window.removeEventListener('hashchange', report);
      window.removeEventListener(DESKTOP_NAVIGATION_EVENT, report);
    };
  }, [app, profileId, transportScope, canManageInstances]);

  useEffect(() => app.onNativeCommand?.(setPendingCommand), [app]);

  useEffect(() => {
    if (!pendingCommand) return;
    const { command, connectionScope } = pendingCommand;
    if (command === 'quit') {
      if (confirmPlanStudioDiscard()) void app.quit?.().catch(() => undefined);
      setPendingCommand(null);
      return;
    }
    if (command === 'diagnostics') {
      onDiagnostics();
      setPendingCommand(null);
      return;
    }
    if (command === 'manage-instances' || command === 'connect-instance') {
      if (!canManageInstances) {
        setPendingCommand(null);
        return;
      }
      if (!confirmPlanStudioDiscard()) {
        setPendingCommand(null);
        return;
      }
      if (command === 'connect-instance') onConnectInstance();
      else if (state.phase === 'connected') onManageInstances();
      else onChooseInstances();
      setPendingCommand(null);
      return;
    }
    if (state.phase !== 'connected') {
      setPendingCommand(null);
      return;
    }
    if (!matchesConnectedScope(connectionScope, state)) {
      setPendingCommand(null);
      return;
    }
    if (command === 'search' || command === 'toggle-sidebar') {
      onNavigate?.();
      window.dispatchEvent(new CustomEvent(DESKTOP_UI_COMMAND_EVENT, { detail: command }));
    } else navigateNativeCommand(command, history.current, onNavigate);
    setPendingCommand(null);
  }, [app, canManageInstances, onConnectInstance, onDiagnostics, onChooseInstances, onManageInstances, onNavigate, pendingCommand, state]);

  // Effect Events expose only the latest committed render, and update before
  // layout effects can dispatch a shortcut for that commit.
  const handleKeyboard = useEffectEvent((event: KeyboardEvent) => {
    if (state.phase !== 'connected') return;
    if (canManageInstances && !app.onNativeCommand && (event.metaKey || event.ctrlKey)
        && event.shiftKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      if (confirmPlanStudioDiscard()) onManageInstances();
    } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      void onReconnect(state.profile);
    }
  });

  useEffect(() => {
    document.addEventListener('keydown', handleKeyboard);
    return () => document.removeEventListener('keydown', handleKeyboard);
    // Effect Events must not be dependencies of the effect that invokes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};
