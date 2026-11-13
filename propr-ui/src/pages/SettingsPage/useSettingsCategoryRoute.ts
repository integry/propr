import { useSearchParams } from 'react-router-dom';
import { DEFAULT_SETTINGS_CATEGORY, SETTINGS_CATEGORIES, type SettingsCategoryId } from './SettingsNavigation';

/** Retired category ids, kept so saved links keep landing nearby. */
const LEGACY_SETTINGS_CATEGORIES = new Map<string, SettingsCategoryId>([
  // The old horizontal layout's tab.
  ['automation', 'workflow'],
  // General held only usage tips and opt-ins, and became Experimental.
  ['general', 'experimental'],
]);

// A Map, not an object literal: `?tab=toString` must not resolve to an
// inherited Object.prototype member.
const settingsCategoryFrom = (value: string | null): SettingsCategoryId => {
  if (value === null) return DEFAULT_SETTINGS_CATEGORY;
  const legacy = LEGACY_SETTINGS_CATEGORIES.get(value);
  if (legacy) return legacy;
  return SETTINGS_CATEGORIES.some(category => category.id === value)
    ? value as SettingsCategoryId
    : DEFAULT_SETTINGS_CATEGORY;
};

export const useSettingsCategoryRoute = (): {
  activeCategory: SettingsCategoryId;
  onActiveCategoryChange(category: SettingsCategoryId): void;
  /** The URL names a category, so phones open it directly instead of the category list. */
  openCategoryOnMobile: boolean;
} => {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeCategory = settingsCategoryFrom(searchParams.get('tab'));

  const onActiveCategoryChange = (category: SettingsCategoryId): void => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (category === DEFAULT_SETTINGS_CATEGORY) next.delete('tab');
      else next.set('tab', category);
      return next;
    }, { replace: true });
  };

  return { activeCategory, onActiveCategoryChange, openCategoryOnMobile: searchParams.has('tab') };
};
