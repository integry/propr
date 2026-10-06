import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { InstanceCatalogAgent } from '@propr/shared';
import Alert from '../Alert';
import { SettingsField, SettingsSection, SettingsStatus } from '../SettingsLayout';
import { SETTINGS_CONTROL } from '../settingsStyles';
import type { Settings } from '../types';
import { ScheduleCreateForm } from './ScheduleCreateForm';
import { ScheduleList } from './ScheduleList';
import { useSchedules } from './useSchedules';

/** DOM id that notifications link to: `/settings?tab=automation#scheduled-tasks`. */
export const SCHEDULED_TASKS_SECTION_ID = 'scheduled-tasks';
export const SCHEDULED_TASKS_SEARCH_TEXT = 'scheduled recurring tasks cron schedule run now unattended work admission max concurrent window nightly weekly';

type AdmissionSettings = Pick<Settings, 'unattended_max_concurrent' | 'unattended_window' | 'unattended_window_error'>;

interface ScheduledTasksSectionProps {
  settings: AdmissionSettings;
  agents: InstanceCatalogAgent[];
  onChange(event: React.ChangeEvent<HTMLInputElement>): void;
  onBlur(): void;
  /** The shared settings save status; a completed save refreshes the admission state. */
  saveStatus?: 'idle' | 'saving' | 'saved' | 'warning' | 'error';
}

function useScrollIntoViewOnHash(id: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || window.location.hash !== `#${id}`) return;
    // Scroll only the settings panel: scrollIntoView would also shift the app shell under its header.
    const scroller = element.closest<HTMLElement>('.overflow-y-auto');
    if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
    else element.scrollIntoView?.({ block: 'start' });
  }, [id]);
  return ref;
}

export function ScheduledTasksSection({ settings, agents, onChange, onBlur, saveStatus }: ScheduledTasksSectionProps) {
  const { schedules, admission, loading, error, refresh, create, setEnabled, remove, runNow } = useSchedules();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone: 'error' | 'success' } | null>(null);
  const ref = useScrollIntoViewOnHash(SCHEDULED_TASKS_SECTION_ID);

  // The window is validated on the server; re-read it once a settings save lands.
  useEffect(() => {
    if (saveStatus === 'saved' || saveStatus === 'warning') void refresh();
  }, [saveStatus, refresh]);

  const onNotice = useCallback((message: string | null, tone: 'error' | 'success' = 'success') => {
    setNotice(message ? { message, tone } : null);
  }, []);

  const windowError = admission ? admission.windowError : settings.unattended_window_error ?? null;
  const running = admission?.running;

  return (
    <div id={SCHEDULED_TASKS_SECTION_ID} ref={ref} className="scroll-mt-6">
      <SettingsSection
        title="Scheduled tasks"
        description="Recurring tasks that run unattended on a cron schedule. Scheduled runs are admitted only within the unattended-work limits below; manual runs are never held back."
        status={running !== undefined && <SettingsStatus tone={running > 0 ? 'ok' : 'pending'}>{running} unattended running</SettingsStatus>}
      >
        {windowError && (
          <div role="alert"><Alert type="warning" message={`Unattended work is blocked: ${windowError}`} /></div>
        )}
        <SettingsField label="Max concurrent unattended tasks" htmlFor="unattended_max_concurrent"
          helperText="0–100. A scheduled run that would exceed this limit is skipped, not retried; 0 blocks unattended work.">
          <input id="unattended_max_concurrent" name="unattended_max_concurrent" type="number" min={0} max={100} step={1}
            className={SETTINGS_CONTROL} value={settings.unattended_max_concurrent} onChange={onChange} onBlur={onBlur} />
        </SettingsField>
        <SettingsField label="Unattended window" htmlFor="unattended_window"
          helperText="Local time range in which unattended work may start, as HH:MM-HH:MM@Area/City. Leave empty to allow any time. A malformed window blocks all unattended work until it is fixed.">
          <input id="unattended_window" name="unattended_window" type="text" className={SETTINGS_CONTROL}
            value={settings.unattended_window} placeholder="02:00-07:00@Europe/Riga" onChange={onChange} onBlur={onBlur} />
        </SettingsField>

        <div className="mb-3 mt-8 flex max-w-3xl items-center justify-between gap-3">
          <h5 className="text-sm font-semibold text-slate-900">Schedules</h5>
          {!creating && (
            <button type="button" onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />New schedule
            </button>
          )}
        </div>
        {notice && (
          <p role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`mb-3 max-w-3xl rounded border px-3 py-2 text-[12px] ${notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-teal-200 bg-teal-50 text-teal-800'}`}>
            {notice.message}
          </p>
        )}
        {error && <Alert type="error" message={`Could not load schedules: ${error}`} />}
        {loading
          ? <p className="text-[12px] text-slate-500">Loading schedules…</p>
          : <ScheduleList schedules={schedules} actions={{ setEnabled, remove, runNow }} onNotice={onNotice} />}
        {creating && (
          <ScheduleCreateForm
            agents={agents}
            onCancel={() => setCreating(false)}
            onCreate={async input => {
              const schedule = await create(input);
              setCreating(false);
              onNotice(`${schedule.name} scheduled.`);
              return schedule;
            }}
          />
        )}
      </SettingsSection>
    </div>
  );
}

export default ScheduledTasksSection;
