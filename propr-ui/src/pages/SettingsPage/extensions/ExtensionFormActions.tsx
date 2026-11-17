import type { ReactNode } from 'react';

/**
 * The actions of an extension form. On a phone they stay pinned to the bottom
 * of the screen while the long form scrolls; from the sm breakpoint they sit
 * under the form as usual.
 */
export const ExtensionFormActions = ({ children }: { children: ReactNode }) => (
  <div data-testid="extension-form-actions"
    className="sticky bottom-0 z-10 -mx-3 -mb-3 flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white/95 px-3 py-2 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
    {children}
  </div>
);
