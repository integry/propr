import { describe, expect, test } from 'vitest';
import { expectExistingDocsRoute } from './docsRoutes.testUtils';
import { SETTINGS_CATEGORIES } from './SettingsNavigation';
import { SETTINGS_CATEGORY_GUIDES } from './settingsCategoryGuides';

describe('settings category guides', () => {
  test('cover every category', () => {
    expect(Object.keys(SETTINGS_CATEGORY_GUIDES).sort()).toEqual(SETTINGS_CATEGORIES.map(category => category.id).sort());
  });

  const links = Object.entries(SETTINGS_CATEGORY_GUIDES)
    .flatMap(([category, guide]) => guide.links.map(link => [category, link.href] as const));

  test.each(links)('%s links to an existing docs page and heading: %s', (_category, href) => {
    expectExistingDocsRoute(href);
  });

  test('rejects a docs route that does not exist', () => {
    expect(() => expectExistingDocsRoute('https://docs.propr.dev/docs/features/pr-ultrafix-commands')).toThrow();
    expect(() => expectExistingDocsRoute('https://docs.propr.dev/docs/features/pr-commands#no-such-heading')).toThrow();
  });
});
