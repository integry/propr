import React, { useEffect, useState } from 'react';
import { Image, Video } from 'lucide-react';
import type { MonitoredRepo } from '../api/proprApi';

export type RepositoryVisualPreviewSettings = NonNullable<MonitoredRepo['visualPreview']>;

interface RepositoryVisualPreviewControlProps {
  repo: MonitoredRepo;
  onUpdate: (repoId: string, settings: RepositoryVisualPreviewSettings) => void;
  isReadOnly: boolean;
}

export const RepositoryVisualPreviewControl: React.FC<RepositoryVisualPreviewControlProps> = ({ repo, onUpdate, isReadOnly }) => {
  const settings: RepositoryVisualPreviewSettings = repo.visualPreview || { enabled: false, types: ['image'] };
  const [instructions, setInstructions] = useState(settings.instructions || '');

  useEffect(() => setInstructions(settings.instructions || ''), [settings.instructions]);

  if (isReadOnly) return null;

  const settingsWithCurrentInstructions = (): RepositoryVisualPreviewSettings => {
    const normalizedInstructions = instructions.trim();
    return {
      ...settings,
      ...(normalizedInstructions ? { instructions: normalizedInstructions } : { instructions: undefined })
    };
  };

  const toggleType = (type: 'image' | 'video') => {
    const selected = settings.types.includes(type);
    if (selected && settings.types.length === 1) return;
    onUpdate(repo.id, {
      ...settingsWithCurrentInstructions(),
      types: selected ? settings.types.filter(candidate => candidate !== type) : [...settings.types, type]
    });
  };

  return (
    <div className="mt-2 text-[11px] text-slate-600" onClick={(event) => event.stopPropagation()}>
      <label className="inline-flex items-center gap-2 cursor-pointer" title="Generate focused media for changes with a visible result">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={() => onUpdate(repo.id, { ...settingsWithCurrentInstructions(), enabled: !settings.enabled })}
          className="sr-only peer"
          aria-label={`Visual previews for ${repo.name}`}
        />
        <span className="relative w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full" />
        <span>Visual previews</span>
        <span className={`rounded px-1.5 py-0.5 font-medium ${settings.enabled ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>
          {settings.enabled ? 'On' : 'Off'}
        </span>
      </label>

      {settings.enabled && (
        <div className="mt-2 ml-9 space-y-2" onClick={(event) => event.stopPropagation()}>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => toggleType('image')}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors ${settings.types.includes('image') ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-500'}`}
              aria-pressed={settings.types.includes('image')}
              title={settings.types.length === 1 && settings.types.includes('image') ? 'At least one preview type is required' : 'Include image previews'}
            >
              <Image className="h-3 w-3" /> Images
            </button>
            <button
              type="button"
              onClick={() => toggleType('video')}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors ${settings.types.includes('video') ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-500'}`}
              aria-pressed={settings.types.includes('video')}
              title={settings.types.length === 1 && settings.types.includes('video') ? 'At least one preview type is required' : 'Include video previews'}
            >
              <Video className="h-3 w-3" /> Videos
            </button>
          </div>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onBlur={() => {
              const normalized = instructions.trim();
              if (normalized !== (settings.instructions || '')) {
                onUpdate(repo.id, settingsWithCurrentInstructions());
              }
            }}
            maxLength={4000}
            rows={2}
            className="w-full max-w-sm resize-y rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-700 placeholder:text-slate-400 focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
            placeholder="Optional: capture separate desktop and mobile views…"
            aria-label={`Visual preview instructions for ${repo.name}`}
          />
        </div>
      )}
    </div>
  );
};
