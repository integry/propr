import React from 'react';
import { ChevronLeft, Search, X } from 'lucide-react';

/** The settings search box, with a clear button once something is typed. */
export const SettingsSearchField: React.FC<{ query: string; onQueryChange(query: string): void }> = ({ query, onQueryChange }) => (
  <div className="relative">
    <label htmlFor="settings-search" className="sr-only">Search settings</label>
    <Search
      aria-hidden="true"
      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
    />
    <input
      id="settings-search"
      type="search"
      value={query}
      onChange={event => onQueryChange(event.target.value)}
      placeholder="Search settings..."
      className="h-9 w-full rounded border border-slate-300 bg-slate-50 pl-9 pr-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
    />
    {query && (
      <button
        type="button"
        onClick={() => onQueryChange('')}
        aria-label="Clear settings search"
        className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    )}
  </div>
);

/**
 * The phone header inside a category: a back button to the category list and
 * the category's name. The page header (and its demo-mode notice) is hidden
 * here, so a read-only hint explains why the controls are inert.
 */
export const MobileCategoryHeader: React.FC<{ label: string; isReadOnly: boolean; onBack(): void }> = ({ label, isReadOnly, onBack }) => (
  <div className="flex-shrink-0 border-b border-slate-200 bg-white md:hidden" data-settings-mobile-header>
    <div className="flex items-center px-2 py-1.5">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to Settings"
        className="inline-flex flex-shrink-0 items-center gap-0.5 rounded px-1.5 py-1.5 text-sm font-medium text-teal-700 hover:bg-teal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <ChevronLeft aria-hidden="true" className="h-5 w-5" />
        Settings
      </button>
      <span className="min-w-0 flex-1 truncate pr-2 text-center text-sm font-semibold text-slate-900">{label}</span>
      {/* Balances the back button so the title stays centred. */}
      <span aria-hidden="true" className="w-[5.5rem] flex-shrink-0" />
    </div>
    {isReadOnly && (
      <p className="px-4 pb-2 text-center text-[12px] text-amber-700">Demo mode is read-only.</p>
    )}
  </div>
);
