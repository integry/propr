import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';

export type SettingsCategoryId = 'models' | 'automation' | 'integrations' | 'notifications';

interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'models',
    label: 'AI & Models',
    description: 'Choose models and configure the repository knowledge base.'
  },
  {
    id: 'automation',
    label: 'Automation',
    description: 'Control processing rules, labels, follow-ups, and worker behavior.'
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Connect supporting services and customize agent runtimes.'
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Choose which updates reach your inbox and browser.'
  }
];

export interface SettingsNavigationSection {
  id: string;
  category: SettingsCategoryId;
  searchText: string;
  content: React.ReactNode;
}

interface SettingsNavigationProps {
  sections: SettingsNavigationSection[];
  isReadOnly?: boolean;
  activeCategory?: SettingsCategoryId;
  onActiveCategoryChange?(category: SettingsCategoryId): void;
}

// eslint-disable-next-line react-refresh/only-export-components
export function matchesSettingsSearch(section: SettingsNavigationSection, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const searchableText = `${section.id} ${section.searchText}`.toLocaleLowerCase();
  return terms.every(term => searchableText.includes(term));
}

const SettingsNavigation: React.FC<SettingsNavigationProps> = ({
  sections,
  isReadOnly = false,
  activeCategory: controlledActiveCategory,
  onActiveCategoryChange,
}) => {
  const [localActiveCategory, setLocalActiveCategory] = useState<SettingsCategoryId>('models');
  const [query, setQuery] = useState('');
  const activeCategory = controlledActiveCategory ?? localActiveCategory;
  const normalizedQuery = query.trim();

  const selectCategory = (category: SettingsCategoryId): void => {
    setLocalActiveCategory(category);
    onActiveCategoryChange?.(category);
    setQuery('');
  };

  const matchedSectionIds = useMemo(
    () => new Set(sections.filter(section => matchesSettingsSearch(section, normalizedQuery)).map(section => section.id)),
    [normalizedQuery, sections]
  );

  const searchResultCount = normalizedQuery ? matchedSectionIds.size : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-shrink-0 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-stretch gap-3 border-b border-slate-200 px-4 sm:flex-row sm:items-end sm:gap-6">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex min-w-max gap-6" role="tablist" aria-label="Settings categories">
              {SETTINGS_CATEGORIES.map(category => {
                const selected = activeCategory === category.id;
                return (
                  <button
                    key={category.id}
                    id={`settings-tab-${category.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`settings-panel-${category.id}`}
                    onClick={() => selectCategory(category.id)}
                    className={`inline-flex items-center border-b-2 pb-2 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 ${
                      selected
                        ? 'border-teal-600 font-semibold text-teal-700'
                        : 'border-transparent font-medium text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    {category.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative order-first w-full flex-shrink-0 sm:order-none sm:mb-2 sm:ml-auto sm:w-64">
            <label htmlFor="settings-search" className="sr-only">Search settings</label>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            />
            <input
              id="settings-search"
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search settings..."
              className="h-9 w-full rounded border border-slate-300 bg-slate-50 pl-9 pr-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear settings search"
                className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <p className="sr-only" aria-live="polite">
          {normalizedQuery
            ? `${searchResultCount} settings ${searchResultCount === 1 ? 'section' : 'sections'} found.`
            : `${SETTINGS_CATEGORIES.find(category => category.id === activeCategory)?.label} settings selected.`}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-white">
        <div className="mx-auto max-w-4xl px-4 py-8">
          {normalizedQuery && (
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Search results</h3>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {searchResultCount} {searchResultCount === 1 ? 'section' : 'sections'} matching “{normalizedQuery}”
                </p>
              </div>
            </div>
          )}

          {SETTINGS_CATEGORIES.map(category => {
            const categorySections = sections.filter(section => section.category === category.id);
            const visibleSections = normalizedQuery
              ? categorySections.filter(section => matchedSectionIds.has(section.id))
              : categorySections;
            const categoryIsVisible = normalizedQuery
              ? visibleSections.length > 0
              : activeCategory === category.id;

            return (
              <section
                key={category.id}
                id={`settings-panel-${category.id}`}
                role={normalizedQuery ? 'region' : 'tabpanel'}
                aria-labelledby={`settings-tab-${category.id}`}
                hidden={!categoryIsVisible}
              >
                <div className={normalizedQuery ? 'mb-6 mt-8 first:mt-0' : 'mb-8'}>
                  <h3 className="text-sm font-semibold text-slate-900">{category.label}</h3>
                  <p className="mt-0.5 max-w-2xl text-[12px] leading-5 text-slate-500">{category.description}</p>
                </div>

                <div className="space-y-10">
                  {categorySections.map(section => (
                    <div
                      key={section.id}
                      hidden={normalizedQuery ? !matchedSectionIds.has(section.id) : false}
                      data-settings-section={section.id}
                    >
                      <fieldset disabled={isReadOnly} className={isReadOnly ? 'opacity-70' : ''}>
                        {section.content}
                      </fieldset>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {normalizedQuery && searchResultCount === 0 && (
            <div className="border-t border-slate-200 px-6 py-12 text-center">
              <Search aria-hidden="true" className="mx-auto h-6 w-6 text-slate-300" />
              <h3 className="mt-3 text-sm font-medium text-slate-900">No settings found</h3>
              <p className="mt-1 text-[12px] text-slate-500">Try a different keyword or clear the search.</p>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-4 rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Clear search
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsNavigation;
