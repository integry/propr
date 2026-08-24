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
  <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
    />
    <span className={hideLabel ? 'sr-only' : ''}>{label}</span>
  </label>
);

const EnrollmentControl: React.FC = () => {
  const push = useBrowserPush();
  const busy = push.operation !== 'idle';

  if (push.isLoading) {
    return <p className="text-xs text-gray-500">Checking this browser...</p>;
  }
  if (!push.capabilities?.push.configured) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        Web Push is not configured for this ProPR instance. An administrator must configure
        the VAPID keys before this browser can be enabled.
      </div>
    );
  }
  if (push.requiresIosInstallation) {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-800">
        On iPhone and iPad, Safari only allows Web Push for Home Screen apps. Open the Share
        menu, choose <strong>Add to Home Screen</strong>, then open ProPR from its new icon.
      </div>
    );
  }
  if (!push.serviceWorkerSupported || !push.pushApiSupported || !push.notificationApiSupported) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
        This browser does not support the service worker and Push APIs required for notifications.
      </div>
    );
  }
  if (push.permission === 'denied') {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">
        Notifications are blocked for this site. Open your browser’s site settings, allow
        notifications for ProPR, and then reload this page.
      </div>
    );
  }
  if (!push.serviceWorkerRegistration) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
        The ProPR service worker is unavailable. Reload the page and try again.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => void (push.subscription ? push.disable() : push.enable()).catch(() => undefined)}
        className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
          push.subscription
            ? 'bg-gray-700 hover:bg-gray-800 focus:ring-gray-500'
            : 'bg-primary-600 hover:bg-primary-700 focus:ring-primary-500'
        }`}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {push.subscription
          ? push.operation === 'disabling' ? 'Disabling...' : 'Disable on this browser'
          : push.operation === 'enabling' ? 'Enabling...' : 'Enable on this browser'}
      </button>
      <span className={`text-xs ${push.subscription ? 'text-green-700' : 'text-gray-500'}`}>
        {push.subscription ? 'This browser is subscribed.' : 'Your browser will ask for permission.'}
      </span>
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
    <section aria-labelledby="notification-settings-heading">
      <div className="mb-4 flex items-center gap-2">
        <Bell className="h-4 w-4 text-gray-500" />
        <h4 id="notification-settings-heading" className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
          Personal notifications
        </h4>
        {(loading || saving) && <Loader2 aria-label="Saving notification preferences" className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>

      <div className="space-y-5">
        <div>
          <p className="mb-2 text-xs font-medium text-gray-700">Browser push</p>
          <EnrollmentControl />
          {push.error && <p role="alert" className="mt-2 text-xs text-red-600">{push.error}</p>}
        </div>

        <div>
          <div className="mb-2 grid grid-cols-[1fr_auto_auto] gap-4 border-b border-gray-200 pb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            <span>Category</span>
            <span>Inbox</span>
            <span>Push</span>
          </div>
          <div className="divide-y divide-gray-100">
            {NOTIFICATION_KINDS.map(kind => {
              const preference = snapshot?.preferences[kind];
              return (
                <div key={kind} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-2.5">
                  <div>
                    <p className="text-xs font-medium text-gray-700">{CATEGORY_LABELS[kind].label}</p>
                    <p className="text-[11px] text-gray-500">{CATEGORY_LABELS[kind].description}</p>
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

        <div className="border-t border-gray-200 pt-4">
          <Toggle
            label="Show an unread-count badge on the installed app"
            checked={snapshot?.badgeEnabled ?? true}
            disabled={disabled}
            onChange={badgeEnabled => void save({ badgeEnabled })}
          />
        </div>

        <div className="border-t border-gray-200 pt-4">
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
          <p className="mt-1 text-[11px] text-gray-500">Push deliveries wait until quiet hours end. Inbox items still appear immediately.</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-xs font-medium text-gray-700">
              Start
              <input
                type="time"
                value={snapshot?.quietHours.start ?? '22:00'}
                disabled={disabled || !quietHoursEnabled}
                onChange={event => void save({ quietHours: { start: event.target.value } })}
                className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-primary-500 focus:ring-primary-500"
              />
            </label>
            <label className="text-xs font-medium text-gray-700">
              End
              <input
                type="time"
                value={snapshot?.quietHours.end ?? '07:00'}
                disabled={disabled || !quietHoursEnabled}
                onChange={event => void save({ quietHours: { end: event.target.value } })}
                className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-primary-500 focus:ring-primary-500"
              />
            </label>
          </div>
          <label className="mt-3 block text-xs font-medium text-gray-700">
            Timezone
            <select
              value={snapshot?.quietHours.timezone ?? 'UTC'}
              disabled={disabled}
              onChange={event => void save({ quietHours: { timezone: event.target.value } })}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-primary-500 focus:ring-primary-500"
            >
              {timezones.map(timezone => <option key={timezone} value={timezone}>{timezone}</option>)}
            </select>
          </label>
        </div>

        {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      </div>
    </section>
  );
};

export default NotificationSettingsSection;
