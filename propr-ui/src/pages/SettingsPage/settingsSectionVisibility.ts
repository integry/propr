import { createContext, useContext } from 'react';

/**
 * Whether the settings block around a section is on screen: its category is
 * open, or a search shows it. Every category's sections stay mounted, so a
 * section that reads from the server waits for this before its first request.
 * Outside the settings navigation (a standalone render) it is always true.
 */
export const SettingsSectionVisibleContext = createContext(true);

export const useSettingsSectionVisible = (): boolean => useContext(SettingsSectionVisibleContext);
