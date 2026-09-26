import { describeGitHubAttachmentCapacity, resolveGitHubAttachmentCapacity, type GitHubAttachmentPlanOverride } from '@propr/shared';
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
  const capacity = resolveGitHubAttachmentCapacity(settings.githubAttachmentPlan, settings.githubAttachmentCapacity?.detectedPlan);
  const [instructions, setInstructions] = useState(settings.instructions || '');

  useEffect(() => setInstructions(settings.instructions || ''), [repo.id, settings.instructions]);

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
    <div className="w-full min-w-0 text-xs text-slate-600" onClick={(event) => event.stopPropagation()}>
      <label className="flex items-center justify-between gap-4 py-2 cursor-pointer" title="Generate focused media for changes with a visible result">
        <span className="min-w-0">
          <span className="block">Visual previews</span>
          <span className="mt-1 block text-slate-500">Rendered previews of visual changes appear directly in GitHub pull requests.</span>
        </span>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={() => onUpdate(repo.id, { ...settingsWithCurrentInstructions(), enabled: !settings.enabled })}
          className="sr-only peer"
          aria-label={`Visual previews for ${repo.name}`}
        />
        <span className="relative shrink-0 w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full" />
      </label>

      {settings.enabled && (
        <div className="ml-4 mt-1 mb-2 flex min-w-0 flex-col items-stretch gap-3 border-l-2 border-slate-200 pl-4" onClick={(event) => event.stopPropagation()}>
          <div>
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
          </div>
          <div className="max-w-sm space-y-1">
            <label className="flex flex-wrap items-center gap-2">
              <span>GitHub attachment plan</span>
              <select
                aria-label={`GitHub attachment plan for ${repo.name}`}
                value={settings.githubAttachmentPlan ?? 'auto'}
                disabled={isReadOnly}
                onChange={event => {
                  if (isReadOnly) return;
                  onUpdate(repo.id, {
                    ...settingsWithCurrentInstructions(),
                    githubAttachmentPlan: event.target.value as GitHubAttachmentPlanOverride,
                  });
                }}
                className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700 focus:border-teal-400"
              >
                <option value="auto">Auto (default)</option>
                <option value="free">Free</option>
                <option value="paid">Paid</option>
              </select>
            </label>
            <p role="status" className={capacity.source === 'conservative-fallback' ? 'text-amber-700' : 'text-slate-600'}>
              {describeGitHubAttachmentCapacity(capacity)}
            </p>
          </div>
          <label className="block w-full min-w-0">
            <span className="mb-1 block">Preview instructions</span>
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
              className="min-w-0 w-full resize-y rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
              placeholder="Optional: capture separate desktop and mobile views…"
              aria-label={`Visual preview instructions for ${repo.name}`}
            />
          </label>
        </div>
      )}
    </div>
  );
};
