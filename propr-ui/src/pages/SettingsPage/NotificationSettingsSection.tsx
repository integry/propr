import React, { useEffect, useMemo, useState } from 'react';
import { Bell, Loader2 } from 'lucide-react';
import {
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationPreferencesResponse,
  type NotificationPreferencesUpdate,
} from '@propr/shared';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../../api/notificationApi';
import { useCurrentUser } from '../../contexts/AuthContext';
import { useBrowserPush } from '../../hooks/useBrowserPush';
import { useNotificationCenter } from '../../contexts/NotificationCenterContext';
import { SettingsSection, SettingsStatus } from './SettingsLayout';
import { SETTINGS_CONTROL, SETTINGS_LABEL } from './settingsStyles';

/**
 * One grid template drives both the matrix header and every matrix row, so the
 * Inbox and Push checkboxes stay centred under their own column headers.
 */
const MATRIX_GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-x-4';

const CATEGORY_LABELS: Record<NotificationKind, { label: string; description: string }> = {
  plan: { label: 'Plans', description: 'Plan generation and execution updates.' },
  task: { label: 'Tasks', description: 'Coding task progress and completion.' },
  review: { label: 'Reviews', description: 'Automated review results.' },
  pull_request: { label: 'Pull requests', description: 'Pull request lifecycle changes.' },
  indexing: { label: 'Indexing', description: 'Repository indexing status.' },
  system_failure: { label: 'System failures', description: 'Important operational problems.' },
};

const FALLBACK_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Europe/Riga',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

function browserTimezones(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  const supported = intl.supportedValuesOf?.('timeZone') ?? FALLBACK_TIMEZONES;
  return Array.from(new Set(['UTC', current, ...supported])).sort();
}

async function applyBadgePreference(enabled: boolean): Promise<void> {
  if (enabled) return;
  const badgeNavigator = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
  await badgeNavigator.clearAppBadge?.().catch(() => undefined);
}

const Toggle: React.FC<{
  checked: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}> = ({ checked, disabled, hideLabel = false, label, onChange }) => (
  <label
    className={`inline-flex items-center gap-3 text-sm font-medium text-slate-900 ${
      hideLabel ? 'justify-self-center' : ''
    }`}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 flex-shrink-0 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
    />
    <span className={hideLabel ? 'sr-only' : ''}>{label}</span>
  </label>
);

const EnrollmentControl: React.FC = () => {
  const push = useBrowserPush();
  const busy = push.operation !== 'idle';

  if (push.isLoading) {
    return <p className="text-[12px] leading-5 text-slate-500">Checking this browser...</p>;
  }
  if (push.requiresIosInstallation) {
    return (
      <p className="border-l-2 border-slate-300 pl-3 text-[12px] leading-5 text-slate-600">
        On iPhone and iPad, Safari only allows Web Push for Home Screen apps. Open the Share
        menu, choose <strong className="font-medium text-slate-900">Add to Home Screen</strong>, then open ProPR from its new icon.
      </p>
    );
  }
  if (!push.serviceWorkerSupported || !push.pushApiSupported || !push.notificationApiSupported) {
    return (
      <p className="text-[12px] leading-5 text-slate-500">
        This browser does not support the service worker and Push APIs required for notifications.
      </p>
    );
  }
  if (!push.capabilities?.push.configured) {
    return (
      <p className="border-l-2 border-amber-400 pl-3 text-[12px] leading-5 text-amber-800">
        Browser notifications are unavailable for this ProPR instance. Try again later or contact
        your administrator.
      </p>
    );
  }
  if (push.permission === 'denied') {
    return (
      <p className="border-l-2 border-red-400 pl-3 text-[12px] leading-5 text-red-700">
        Notifications are blocked for this site. Open your browser’s site settings, allow
        notifications for ProPR, and then reload this page.
      </p>
    );
  }
  if (!push.serviceWorkerRegistration) {
    return (
      <p className="text-[12px] leading-5 text-slate-500">
        The ProPR service worker is unavailable. Reload the page and try again.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => void (push.subscription ? push.disable() : push.enable()).catch(() => undefined)}
        className={`inline-flex items-center gap-2 rounded px-3 py-1.5 text-xs font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
          push.subscription
            ? 'bg-slate-700 hover:bg-slate-800 focus:ring-slate-500'
            : 'bg-primary-600 hover:bg-primary-700 focus:ring-primary-500'
        }`}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {push.subscription
          ? push.operation === 'disabling' ? 'Disabling...' : 'Disable on this browser'
          : push.operation === 'enabling' ? 'Enabling...' : 'Enable on this browser'}
      </button>
      {push.subscription
        ? <SettingsStatus tone="ok">This browser is subscribed.</SettingsStatus>
        : <span className="text-[12px] text-slate-500">Your browser will ask for permission.</span>}
    </div>
  );
};

// The preference matrix renders several independently disabled control states.
// eslint-disable-next-line complexity
const NotificationSettingsSection: React.FC = () => {
  const user = useCurrentUser();
  const push = useBrowserPush();
  const { commitBadgeEnabled } = useNotificationCenter();
  const [snapshot, setSnapshot] = useState<NotificationPreferencesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getNotificationPreferences()
      .then(preferences => {
        if (!active) return;
        setSnapshot(preferences);
        commitBadgeEnabled(preferences.badgeEnabled);
        void applyBadgePreference(preferences.badgeEnabled);
      })
      .catch(loadError => {
        if (active) setError((loadError as Error).message || 'Notification preferences could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [commitBadgeEnabled, user?.id]);

  const save = async (update: NotificationPreferencesUpdate): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateNotificationPreferences(update);
      setSnapshot(updated);
      if (update.badgeEnabled !== undefined) commitBadgeEnabled(updated.badgeEnabled);
      if (update.badgeEnabled !== undefined) void applyBadgePreference(updated.badgeEnabled);
    } catch (saveError) {
      setError((saveError as Error).message || 'Notification preferences could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const timezones = useMemo(
    () => browserTimezones(snapshot?.quietHours.timezone ?? 'UTC'),
    [snapshot?.quietHours.timezone],
  );
  const quietHoursEnabled = snapshot?.quietHours.start !== null
    && snapshot?.quietHours.end !== null;
  const disabled = loading || saving || snapshot === null;

  return (
    <div className="space-y-10">
      {push.serviceWorkerOriginSupported && (
        <SettingsSection
          title="Browser push"
          icon={<Bell aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />}
          description="Enroll this browser so ProPR can deliver push notifications while the app is closed."
        >
          <div className="max-w-2xl">
            <EnrollmentControl />
            {push.error && <p role="alert" className="mt-2 text-[12px] leading-5 text-red-600">{push.error}</p>}
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        title="Personal notifications"
        icon={<Bell aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />}
        description="Choose where each kind of update is delivered."
        status={(loading || saving)
          ? <SettingsStatus tone="pending" role="status">
              <span aria-hidden="true">Saving…</span>
              <Loader2 aria-label="Saving notification preferences" className="h-3 w-3 animate-spin text-slate-400" />
            </SettingsStatus>
          : undefined}
      >
        <div className="mb-6 max-w-2xl">
          <div className={`${MATRIX_GRID} border-b border-slate-200 pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500`}>
            <span>Category</span>
            <span className="text-center">Inbox</span>
            <span className="text-center">Push</span>
          </div>
          <div className="divide-y divide-slate-100">
            {NOTIFICATION_KINDS.map(kind => {
              const preference = snapshot?.preferences[kind];
              return (
                <div key={kind} className={`${MATRIX_GRID} py-3`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{CATEGORY_LABELS[kind].label}</p>
                    <p className="mt-0.5 text-[12px] leading-5 text-slate-500">{CATEGORY_LABELS[kind].description}</p>
                  </div>
                  <Toggle
                    label={`Inbox notifications for ${CATEGORY_LABELS[kind].label}`}
                    hideLabel
                    checked={preference?.inboxEnabled ?? false}
                    disabled={disabled}
                    onChange={inboxEnabled => void save({ preferences: { [kind]: { inboxEnabled } } })}
                  />
                  <Toggle
                    label={`Push notifications for ${CATEGORY_LABELS[kind].label}`}
                    hideLabel
                    checked={preference?.pushEnabled ?? false}
                    disabled={disabled}
                    onChange={pushEnabled => void save({ preferences: { [kind]: { pushEnabled } } })}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="mb-6 max-w-2xl">
          <Toggle
            label="Show an unread-count badge on the installed app"
            checked={snapshot?.badgeEnabled ?? true}
            disabled={disabled}
            onChange={badgeEnabled => void save({ badgeEnabled })}
          />
        </div>

        {error && <p role="alert" className="max-w-2xl text-[12px] leading-5 text-red-600">{error}</p>}
      </SettingsSection>

      <SettingsSection
        title="Quiet hours"
        description="Push deliveries wait until quiet hours end. Inbox items still appear immediately."
      >
        <div className="mb-6 max-w-2xl">
          <Toggle
            label="Use quiet hours"
            checked={quietHoursEnabled}
            disabled={disabled}
            onChange={enabled => void save({
              quietHours: enabled
                ? {
                    start: '22:00',
                    end: '07:00',
                    timezone: snapshot?.quietHours.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
                  }
                : { start: null, end: null },
            })}
          />
        </div>

        <div className="mb-6 grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={SETTINGS_LABEL} htmlFor="quiet-hours-start">Start</label>
            <input
              id="quiet-hours-start"
              type="time"
              value={snapshot?.quietHours.start ?? '22:00'}
              disabled={disabled || !quietHoursEnabled}
              onChange={event => void save({ quietHours: { start: event.target.value } })}
              className={`mt-1.5 ${SETTINGS_CONTROL}`}
            />
          </div>
          <div>
            <label className={SETTINGS_LABEL} htmlFor="quiet-hours-end">End</label>
            <input
              id="quiet-hours-end"
              type="time"
              value={snapshot?.quietHours.end ?? '07:00'}
              disabled={disabled || !quietHoursEnabled}
              onChange={event => void save({ quietHours: { end: event.target.value } })}
              className={`mt-1.5 ${SETTINGS_CONTROL}`}
            />
          </div>
        </div>

        <div className="mb-6 max-w-2xl">
          <label className={SETTINGS_LABEL} htmlFor="quiet-hours-timezone">Timezone</label>
          <select
            id="quiet-hours-timezone"
            value={snapshot?.quietHours.timezone ?? 'UTC'}
            disabled={disabled}
            onChange={event => void save({ quietHours: { timezone: event.target.value } })}
            className={`mt-1.5 ${SETTINGS_CONTROL}`}
          >
            {timezones.map(timezone => <option key={timezone} value={timezone}>{timezone}</option>)}
          </select>
        </div>
      </SettingsSection>
    </div>
  );
};

export default NotificationSettingsSection;
