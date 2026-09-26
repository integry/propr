import { useEffect, useState } from 'react';
import { PREVIEW_STORAGE_V1_DEFAULTS, type ManagedPreviewStorageStatus } from '@propr/shared';
import { getManagedPreviewStorageStatus } from '../../api/previewStorageApi';
import { SettingsSection, SettingsStatus, type SettingsStatusTone } from './SettingsLayout';

const descriptions = {
  enabled: 'ProPR Connect stores full-resolution preview originals. GitHub attachments continue to publish as usual.',
  plus_required: 'Managed storage requires ProPR Plus. This installation continues to publish previews through GitHub.',
  disabled: 'Managed storage is disabled by ProPR Connect. GitHub attachment publication remains available.',
  unavailable: 'Managed storage is unavailable. Connect may be offline or may not support preview storage yet. Previews continue through GitHub.',
};
const labels = { enabled: 'Enabled', plus_required: 'Plus required', disabled: 'Disabled', unavailable: 'Unavailable' };
const tones: Record<keyof typeof labels, SettingsStatusTone> = {
  enabled: 'ok', plus_required: 'warn', disabled: 'pending', unavailable: 'warn',
};
function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${Number((value / 1024 ** 3).toFixed(2))} GiB`;
  if (value >= 1024 ** 2) return `${Number((value / 1024 ** 2).toFixed(2))} MiB`;
  return `${value} bytes`;
}

export default function ManagedPreviewStorageSection() {
  const [status, setStatus] = useState<ManagedPreviewStorageStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let active = true;
    void getManagedPreviewStorageStatus().then(value => { if (active) setStatus(value); });
    return () => { active = false; };
  }, []);
  const refresh = async () => {
    setRefreshing(true);
    try { setStatus(await getManagedPreviewStorageStatus()); }
    finally { setRefreshing(false); }
  };
  const values = status?.effective ?? PREVIEW_STORAGE_V1_DEFAULTS;
  return (
    <SettingsSection
      title="Managed preview storage"
      description={status ? descriptions[status.state] : 'Checking ProPR Connect storage availability…'}
      status={
        <SettingsStatus tone={status ? tones[status.state] : 'pending'} role="status">
          {status ? labels[status.state] : 'Loading…'}
        </SettingsStatus>
      }
    >
      <dl className="mb-4 grid max-w-2xl grid-cols-1 gap-x-6 gap-y-3 text-[12px] sm:grid-cols-3">
        <div><dt className="text-slate-500">Installation quota</dt><dd className="mt-0.5 font-medium text-slate-900">{bytes(values.quotaBytes)}</dd></div>
        <div><dt className="text-slate-500">Maximum original size</dt><dd className="mt-0.5 font-medium text-slate-900">{bytes(values.maxObjectBytes)}</dd></div>
        <div><dt className="text-slate-500">Retention</dt><dd className="mt-0.5 font-medium text-slate-900">{values.retentionDays} days</dd></div>
      </dl>
      <div className="flex max-w-2xl items-center justify-between gap-3">
        <p className="text-[12px] leading-5 text-slate-500">{status?.effective ? 'Effective limits reported by ProPR Connect.' : 'Standard Plus limits shown; effective limits are currently unavailable.'}</p>
        <button type="button" disabled={refreshing || !status} onClick={() => void refresh()} className="shrink-0 text-[12px] text-slate-600 underline hover:text-slate-900 disabled:opacity-50">{refreshing ? 'Refreshing…' : 'Refresh status'}</button>
      </div>
    </SettingsSection>
  );
}
