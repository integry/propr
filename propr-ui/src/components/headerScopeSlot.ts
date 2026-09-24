import { createContext, useContext } from 'react';

/**
 * The spot in the global toolbar, immediately left of search, where a page can
 * mount its scope control (the Dashboard's repository filter). The layout owns
 * the element; a page portals into it. `null` outside the layout, and until
 * the toolbar has mounted.
 */
export const HeaderScopeSlotContext = createContext<HTMLElement | null>(null);

export const useHeaderScopeSlot = (): HTMLElement | null => useContext(HeaderScopeSlotContext);
