import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Loader2 } from 'lucide-react';
import type {
  DesktopNotificationPreferences,
  DesktopNotificationScope,
  DesktopNotificationSettings,
} from '../../../../apps/desktop/src/shared/contract';
import { useCurrentUser } from '../../contexts/AuthContext';
import { useDesktop } from '../../desktop/DesktopContext';
import { SettingsSection, SettingsStatus } from './SettingsLayout';

/** Shared by the enable row and every event row so the toggles line up. */
const EVENT_GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-4';

const EVENT_OPTIONS: Array<{
  key: keyof Omit<DesktopNotificationPreferences, 'enabled'>;
  label: string;
  description: string;
}> = [
  { key: 'taskStarted', label: 'Task started', description: 'When a queued task begins running.' },
  { key: 'taskCompleted', label: 'Task completed', description: 'When a task finishes successfully.' },
  { key: 'taskFailed', label: 'Task failed', description: 'When a task stops with an error.' },
  { key: 'taskNeedsAttention', label: 'Needs attention', description: 'When a task requires an action, where supported.' },
];

const Toggle: React.FC<{
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange(checked: boolean): void;
}> = ({ checked, disabled, label, onChange }) => (
  <label className="inline-flex items-center justify-self-center">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 flex-shrink-0 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
    />
    <span className="sr-only">{label}</span>
  </label>
);

const sameScope = (
  left: DesktopNotificationScope,
  right: DesktopNotificationScope,
): boolean => left.profileId === right.profileId
  && left.transportScope === right.transportScope
  && left.userId === right.userId;

// Capability, enrollment, loading, and unsupported states share one compact settings surface.
const DesktopNotificationSettingsSection: React.FC = () => {
  const desktop = useDesktop();
  const user = useCurrentUser();
  const userId = user?.id;
  const notifications = desktop?.notifications;
  const scope = useMemo(
    () => notifications && userId ? notifications.scopeFor(userId) : null,
    [notifications, userId],
  );
  const [settings, setSettings] = useState<DesktopNotificationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const scopeGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;

  useEffect(() => {
    const generation = ++scopeGeneration.current;
    let current = true;
    setSettings(null);
    setBusy(false);
    setError(null);
    setTestResult(null);
    if (!notifications || !scope) return;
    const load = (): void => {
      const request = ++loadGeneration.current;
      setError(null);
      void notifications.bridge.get(scope).then(value => {
        if (current && scopeGeneration.current === generation
          && loadGeneration.current === request) setSettings(value);
      }).catch(loadError => {
        if (current && scopeGeneration.current === generation
          && loadGeneration.current === request) {
          setError((loadError as Error).message || 'Desktop notification settings could not be loaded.');
        }
      });
    };
    load();
    const unsubscribe = notifications.bridge.onSettingsChanged(changedScope => {
      if (sameScope(scope, changedScope)) load();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [notifications, scope]);

  if (!notifications || !scope) return null;
  const capability = settings?.capability;

  const update = async (change: Partial<DesktopNotificationPreferences>): Promise<void> => {
    const generation = scopeGeneration.current;
    const operationScope = scope;
    const operationIsCurrent = (): boolean => scopeGeneration.current === generation
      && currentScope.current === operationScope;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const value = await notifications.bridge.update(scope, change);
      if (operationIsCurrent()) setSettings(value);
    } catch (updateError) {
      if (operationIsCurrent()) {
        setError((updateError as Error).message || 'Desktop notification settings could not be saved.');
      }
    } finally {
      if (operationIsCurrent()) setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    const generation = scopeGeneration.current;
    const operationScope = scope;
    const operationIsCurrent = (): boolean => scopeGeneration.current === generation
      && currentScope.current === operationScope;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await notifications.bridge.test(scope);
      if (operationIsCurrent()) {
        const messages: Record<typeof result.status, string> = {
          accepted: 'The operating system accepted the test notification. A banner may still be suppressed by notification settings, Focus, or Do Not Disturb.',
          failed: capability?.platform === 'darwin'
            ? 'macOS rejected the test notification. Temporary builds may not meet macOS signing requirements; use a signed, installed build to validate delivery.'
            : 'The operating system rejected the test notification. Check the desktop logs for the privacy-safe delivery failure event.',
          unconfirmed: 'The notification request was submitted, but the operating system did not confirm delivery. No banner is assumed.',
          'not-attempted': 'The native notification service is unavailable, disabled, or temporarily rate limited.',
          cancelled: 'The test notification was cancelled before delivery was confirmed.',
        };
        if (result.status === 'failed') setError(messages.failed);
        else setTestResult(messages[result.status]);
      }
    } catch (testError) {
      if (operationIsCurrent()) {
        setError((testError as Error).message || 'The test notification could not be sent.');
      }
    } finally {
      if (operationIsCurrent()) setBusy(false);
    }
  };

  const unsupported = capability?.supported === false;
  const windowsDeferred = capability?.reason === 'platform-deferred';
  const disabled = busy || !settings || unsupported;

  return (
    <SettingsSection
      title="Desktop notifications"
      icon={<BellRing aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />}
      description={`Native task alerts for ${desktop.profile.name} on this device. These are separate from Browser push and inbox preferences.`}
      status={(!settings || busy)
        ? <SettingsStatus tone="pending" role="status">
            <span aria-hidden="true">Syncing…</span>
            <Loader2 aria-label="Loading desktop notification preferences" className="h-3 w-3 animate-spin text-slate-400" />
          </SettingsStatus>
        : undefined}
    >
      {unsupported ? (
        <p className="max-w-2xl text-[12px] leading-5 text-slate-500">
          {windowsDeferred
            ? 'Native task notifications are currently available on Linux and macOS. Windows support is planned.'
            : 'Native notifications are not available in this desktop environment.'}
        </p>
      ) : (
        <>
          <div className="mb-6 max-w-2xl">
            <div className={`${EVENT_GRID} border-b border-slate-200 pb-3`}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">Enable on this device</p>
                <p className="mt-0.5 text-[12px] leading-5 text-slate-500">Off until you choose to enable it. ProPR never prompts on launch.</p>
              </div>
              <Toggle
                label="Enable desktop notifications on this device"
                checked={settings?.preferences.enabled ?? false}
                disabled={disabled}
                onChange={enabled => void update({ enabled })}
              />
            </div>

            <div className="divide-y divide-slate-100">
              {EVENT_OPTIONS.map(option => (
                <div key={option.key} className={`${EVENT_GRID} py-3`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{option.label}</p>
                    <p className="mt-0.5 text-[12px] leading-5 text-slate-500">{option.description}</p>
                  </div>
                  <Toggle
                    label={`Desktop notification for ${option.label}`}
                    checked={settings?.preferences[option.key] ?? false}
                    disabled={disabled}
                    onChange={checked => void update({ [option.key]: checked })}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="mb-6 flex max-w-2xl flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={disabled || !settings?.preferences.enabled}
              onClick={() => void test()}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send test notification
            </button>
            <span className="text-[12px] leading-5 text-slate-500">
              OS notification settings, Focus, and Do Not Disturb can suppress banners.
            </span>
          </div>
        </>
      )}

      {testResult && <p role="status" className="max-w-2xl text-[12px] leading-5 text-slate-600">{testResult}</p>}
      {error && <p role="alert" className="mt-2 max-w-2xl text-[12px] leading-5 text-red-600">{error}</p>}
    </SettingsSection>
  );
};

export default DesktopNotificationSettingsSection;
