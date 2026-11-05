import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Bot,
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  type LucideIcon,
  Plug,
  Puzzle,
  RefreshCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X
} from 'lucide-react';
import { SETTINGS_BLOCK, SETTINGS_CONTAINER } from './settingsStyles';
import SettingsInspector from './SettingsInspector';
import { useDesktopLayout } from '../../hooks/useDesktopLayout';

export type SettingsCategoryId =
  | 'general'
  | 'models'
  | 'workflow'
  | 'ultrafix'
  | 'sandbox'
  | 'agent-extensions'
  | 'integrations'
  | 'notifications';

interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
}

// eslint-disable-next-line react-refresh/only-export-components
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Application preferences for this workspace.',
    icon: SlidersHorizontal
  },
  {
    id: 'models',
    label: 'AI Models & Reasoning',
    description: 'Choose models and configure the repository knowledge base.',
    icon: Bot
  },
  {
    id: 'workflow',
    label: 'Workflow & PR Rules',
    description: 'Processing rules, GitHub triggers, and assignment gates.',
    icon: GitPullRequest
  },
  {
    id: 'ultrafix',
    label: 'Ultrafix & Escalation',
    description: 'Fix-and-review loops and model escalation.',
    icon: RefreshCcw
  },
  {
    id: 'sandbox',
    label: 'Sandbox & Network',
    description: 'Network access and run watchdogs for agent containers.',
    icon: ShieldCheck
  },
  {
    id: 'agent-extensions',
    label: 'Agent Extensions & Packages',
    description: 'MCP tools, skills and system packages available to agents in their containers.',
    icon: Puzzle
  },
  {
    id: 'integrations',
    label: 'Integrations & MCP',
    description: 'Connect supporting services around the agents.',
    icon: Plug
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Choose which updates reach your inbox and browser.',
    icon: Bell
  }
];

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryId = 'general';

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
  /** Page title block, aligned to the settings container. Phones hide it inside a category. */
  header?: React.ReactNode;
  /**
   * Whether phones open straight into the active category (the route names
   * one) rather than on the category list.
   */
  openCategoryOnMobile?: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components
export function matchesSettingsSearch(section: SettingsNavigationSection, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const searchableText = `${section.id} ${section.searchText}`.toLocaleLowerCase();
  return terms.every(term => searchableText.includes(term));
}

const NEXT_TAB_KEYS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

interface SettingsRailTabProps {
  category: SettingsCategory;
  selected: boolean;
  /** The rail's single Tab stop: the selected item, or the one arrow keys last moved to. */
  focusable: boolean;
  tabRef(element: HTMLButtonElement | null): void;
  onSelect(): void;
  onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void;
}

/** A rail item on wider screens; a full-width row with a chevron on phones. */
const SettingsRailTab: React.FC<SettingsRailTabProps> = ({ category, selected, focusable, tabRef, onSelect, onKeyDown }) => {
  const Icon = category.icon;
  return (
    <button
      ref={tabRef}
      id={`settings-tab-${category.id}`}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={`settings-panel-${category.id}`}
      tabIndex={focusable ? 0 : -1}
      title={category.description}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`flex w-full items-center gap-3 px-1 py-3 text-left text-sm font-medium text-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 md:gap-2 md:rounded md:px-2.5 md:py-1.5 md:text-[13px] ${
        selected
          ? 'md:bg-teal-50 md:font-semibold md:text-teal-700'
          : 'md:text-slate-600 md:hover:bg-slate-50 md:hover:text-slate-900'
      }`}
    >
      <Icon aria-hidden="true" className={`h-4 w-4 flex-shrink-0 text-slate-500 ${selected ? 'md:text-teal-600' : 'md:text-slate-400'}`} />
      <span className="min-w-0 flex-1">{category.label}</span>
      <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 flex-shrink-0 text-slate-300 md:hidden" />
    </button>
  );
};

/** The settings search box, with a clear button once something is typed. */
const SettingsSearchField: React.FC<{ query: string; onQueryChange(query: string): void }> = ({ query, onQueryChange }) => (
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
const MobileCategoryHeader: React.FC<{ label: string; isReadOnly: boolean; onBack(): void }> = ({ label, isReadOnly, onBack }) => (
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

interface SettingsCategoryPanelProps {
  category: SettingsCategory;
  sections: SettingsNavigationSection[];
  activeCategory: SettingsCategoryId;
  normalizedQuery: string;
  matchedSectionIds: Set<string>;
  isReadOnly: boolean;
}

/** One category's blocks: its tab panel, or its group of search results. */
const SettingsCategoryPanel: React.FC<SettingsCategoryPanelProps> = ({
  category,
  sections,
  activeCategory,
  normalizedQuery,
  matchedSectionIds,
  isReadOnly,
}) => {
  const visibleSections = normalizedQuery
    ? sections.filter(section => matchedSectionIds.has(section.id))
    : sections;
  const categoryIsVisible = normalizedQuery
    ? visibleSections.length > 0
    : activeCategory === category.id;
  const lastVisibleSection = visibleSections[visibleSections.length - 1];

  return (
    <section
      id={`settings-panel-${category.id}`}
      role={normalizedQuery ? 'region' : 'tabpanel'}
      aria-labelledby={`settings-tab-${category.id}`}
      hidden={!categoryIsVisible}
      className={normalizedQuery ? 'mb-12' : undefined}
    >
      {/* Search results mix categories, so only they name the category a match came from. */}
      {normalizedQuery && (
        <h3 className="mb-6 text-sm font-semibold text-slate-900">{category.label}</h3>
      )}

      {/* Each block is closed by its own rule, so trailing helper text never drifts under the next block's header. */}
      <div>
        {sections.map(section => (
          <div
            key={section.id}
            hidden={!visibleSections.includes(section)}
            className={section === lastVisibleSection ? undefined : SETTINGS_BLOCK}
            data-settings-section={section.id}
          >
            {/* Override the fieldset default so tables cannot widen the reading pane. */}
            <fieldset disabled={isReadOnly} className={`min-w-0 ${isReadOnly ? 'opacity-70' : ''}`}>
              {section.content}
            </fieldset>
          </div>
        ))}
      </div>
    </section>
  );
};

/**
 * Settings as a split-pane console: a vertical category rail on the left, a
 * reading pane held to `max-w-2xl`, and on 2xl screens an inspector that
 * explains the open category. The selected rail item names the open category,
 * so the pane carries no second heading for it.
 *
 * Phones drill in instead: the rail becomes a full-width list of categories,
 * and choosing one replaces the list with that category under a
 * "Settings" back button.
 */
const SettingsNavigation: React.FC<SettingsNavigationProps> = ({
  sections,
  isReadOnly = false,
  activeCategory: controlledActiveCategory,
  onActiveCategoryChange,
  header,
  openCategoryOnMobile = false,
}) => {
  const [localActiveCategory, setLocalActiveCategory] = useState<SettingsCategoryId>(DEFAULT_SETTINGS_CATEGORY);
  const [query, setQuery] = useState('');
  const [mobileCategoryOpen, setMobileCategoryOpen] = useState(openCategoryOnMobile);
  // Phones move focus through the category list without opening anything.
  const [focusedCategory, setFocusedCategory] = useState<SettingsCategoryId | null>(null);
  const isDesktop = useDesktopLayout();
  const tabRefs = useRef<Partial<Record<SettingsCategoryId, HTMLButtonElement | null>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeCategory = controlledActiveCategory ?? localActiveCategory;
  const activeCategoryDetails = SETTINGS_CATEGORIES.find(category => category.id === activeCategory) ?? SETTINGS_CATEGORIES[0];
  const normalizedQuery = query.trim();

  // A route that names a category (a deep link, or a notification opening
  // its settings) opens that category on phones too.
  useEffect(() => {
    if (openCategoryOnMobile) setMobileCategoryOpen(true);
  }, [openCategoryOnMobile, activeCategory]);

  // A newly opened category, or the list a phone returns to, starts at its top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeCategory, mobileCategoryOpen]);

  // Phones search from the category list, so clearing a search returns there
  // rather than to a category opened before the search began.
  const handleQueryChange = (nextQuery: string): void => {
    if (nextQuery.trim() && !normalizedQuery) setMobileCategoryOpen(false);
    setQuery(nextQuery);
  };

  const selectCategory = (category: SettingsCategoryId): void => {
    setLocalActiveCategory(category);
    setFocusedCategory(null);
    onActiveCategoryChange?.(category);
    setQuery('');
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null;
    if (event.key in NEXT_TAB_KEYS) {
      nextIndex = (index + NEXT_TAB_KEYS[event.key] + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SETTINGS_CATEGORIES.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = SETTINGS_CATEGORIES[nextIndex].id;
    // Wider screens show the rail beside the pane, so arrows select as they
    // move. On phones selecting would replace the list with the category
    // (a routed category opens there), hiding the item just focused, so
    // arrows only move focus and Enter, Space or a tap opens it.
    if (isDesktop) selectCategory(next);
    else setFocusedCategory(next);
    tabRefs.current[next]?.focus();
  };

  const matchedSectionIds = useMemo(
    () => new Set(sections.filter(section => matchesSettingsSearch(section, normalizedQuery)).map(section => section.id)),
    [normalizedQuery, sections]
  );

  const searchResultCount = normalizedQuery ? matchedSectionIds.size : 0;
  // Phones show either the category list (with search) or one category, never both.
  const phoneShowsCategory = mobileCategoryOpen && !normalizedQuery;

  return (
    <>
      <div className={`flex-shrink-0 pb-4 pt-6 ${phoneShowsCategory ? 'hidden md:block' : ''}`} data-settings-header>
        <div className={SETTINGS_CONTAINER}>{header}</div>
      </div>

      {phoneShowsCategory && (
        <MobileCategoryHeader
          label={activeCategoryDetails.label}
          isReadOnly={isReadOnly}
          onBack={() => setMobileCategoryOpen(false)}
        />
      )}

      {/* Outside the rail, which phones hide inside a category, so announcements reach both phone screens. */}
      <p className="sr-only" aria-live="polite" data-settings-announcement>
        {normalizedQuery
          ? `${searchResultCount} settings ${searchResultCount === 1 ? 'section' : 'sections'} found.`
          : `${activeCategoryDetails.label} settings selected.`}
      </p>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-white" data-settings-scroll>
        <div className={`${SETTINGS_CONTAINER} flex flex-col md:flex-row md:items-start md:gap-10`}>
          <nav
            aria-label="Settings"
            data-settings-rail
            className={`${phoneShowsCategory ? 'hidden' : 'flex'} flex-shrink-0 flex-col gap-3 bg-white pb-3 pt-2 md:sticky md:top-0 md:z-10 md:flex md:w-56 md:pb-8`}
          >
            <SettingsSearchField query={query} onQueryChange={handleQueryChange} />

            <div
              className={`${normalizedQuery ? 'hidden md:flex' : 'flex'} flex-col divide-y divide-slate-100 border-y border-slate-100 md:gap-1 md:divide-y-0 md:border-y-0`}
              role="tablist"
              aria-label="Settings categories"
              aria-orientation="vertical"
            >
              {SETTINGS_CATEGORIES.map((category, index) => (
                <SettingsRailTab
                  key={category.id}
                  category={category}
                  selected={activeCategory === category.id}
                  focusable={(focusedCategory ?? activeCategory) === category.id}
                  tabRef={element => { tabRefs.current[category.id] = element; }}
                  onSelect={() => {
                    selectCategory(category.id);
                    setMobileCategoryOpen(true);
                  }}
                  onKeyDown={event => handleTabKeyDown(event, index)}
                />
              ))}
            </div>

          </nav>

          <div
            className={`${phoneShowsCategory || normalizedQuery ? 'block' : 'hidden'} min-w-0 max-w-2xl flex-1 pb-16 pt-4 md:block md:pt-2`}
            data-settings-pane
          >
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

            {SETTINGS_CATEGORIES.map(category => (
              <SettingsCategoryPanel
                key={category.id}
                category={category}
                sections={sections.filter(section => section.category === category.id)}
                activeCategory={activeCategory}
                normalizedQuery={normalizedQuery}
                matchedSectionIds={matchedSectionIds}
                isReadOnly={isReadOnly}
              />
            ))}

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

          {!normalizedQuery && <SettingsInspector categoryId={activeCategoryDetails.id} label={activeCategoryDetails.label} />}
        </div>
      </div>
    </>
  );
};

export default SettingsNavigation;
