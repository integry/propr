import { useSearchParams } from 'react-router-dom';
import { SETTINGS_CATEGORIES, type SettingsCategoryId } from './SettingsNavigation';

const settingsCategoryFrom = (value: string | null): SettingsCategoryId =>
  SETTINGS_CATEGORIES.some(category => category.id === value)
    ? value as SettingsCategoryId
    : 'models';

export const useSettingsCategoryRoute = (): {
  activeCategory: SettingsCategoryId;
  onActiveCategoryChange(category: SettingsCategoryId): void;
} => {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeCategory = settingsCategoryFrom(searchParams.get('tab'));

  const onActiveCategoryChange = (category: SettingsCategoryId): void => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (category === 'models') next.delete('tab');
      else next.set('tab', category);
      return next;
    }, { replace: true });
  };

  return { activeCategory, onActiveCategoryChange };
};
