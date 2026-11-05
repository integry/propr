import React from 'react';
import { BookOpen, ExternalLink } from 'lucide-react';
import type { SettingsCategoryId } from './SettingsNavigation';
import { SETTINGS_CATEGORY_GUIDES } from './settingsCategoryGuides';

/**
 * Background for the open category, in the column right of the reading pane.
 * Only 2xl screens have room for it; narrower ones keep the form alone.
 */
const SettingsInspector: React.FC<{ categoryId: SettingsCategoryId; label: string }> = ({ categoryId, label }) => {
  const guide = SETTINGS_CATEGORY_GUIDES[categoryId];
  return (
    <aside
      aria-label={`About ${label}`}
      data-settings-inspector
      className="sticky top-0 hidden w-64 flex-shrink-0 pb-8 pt-2 2xl:block"
    >
      <div className="border-l border-slate-200 pl-6">
        <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">
          <BookOpen aria-hidden="true" className="h-3.5 w-3.5" />
          How it works
        </h3>
        <p className="mt-3 text-[13px] leading-5 text-slate-700">{guide.summary}</p>
        <ul className="mt-4 space-y-3">
          {guide.notes.map(note => (
            <li key={note} className="text-[12px] leading-5 text-slate-500">{note}</li>
          ))}
        </ul>
        <div className="mt-5 flex flex-col items-start gap-1.5 border-t border-slate-100 pt-4">
          {guide.links.map(link => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] font-medium text-teal-700 hover:text-teal-800 hover:underline"
            >
              {link.label}
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </a>
          ))}
        </div>
      </div>
    </aside>
  );
};

export default SettingsInspector;
