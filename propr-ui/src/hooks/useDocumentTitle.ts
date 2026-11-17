import { useEffect, useRef } from 'react';

const APP_NAME = 'ProPR';
/** Every tab reads "<Page> · ProPR". */
const TITLE_SEPARATOR = ' · ';

/** The tab title for a page, or the app name alone for an empty page title. */
export const formatDocumentTitle = (title?: string): string =>
  title?.trim() ? `${title.trim()}${TITLE_SEPARATOR}${APP_NAME}` : APP_NAME;

/**
 * Custom hook for dynamic document title management.
 * Updates the browser's document title and restores the original title on unmount.
 *
 * @param title - The page-specific title to display (e.g., "Settings", "Task #123")
 *                If empty or undefined, only the app name "ProPR" will be shown.
 *
 * @example
 * // Shows "Settings · ProPR" in the browser tab
 * useDocumentTitle('Settings');
 *
 * @example
 * // Shows "ProPR" in the browser tab
 * useDocumentTitle('');
 *
 * @param enabled - When false the hook leaves the title alone, for a view
 *                  embedded in a page that owns the title.
 */
export function useDocumentTitle(title?: string, enabled = true): void {
  const originalTitleRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // Store the original title on first mount
    if (originalTitleRef.current === null) {
      originalTitleRef.current = document.title;
    }

    document.title = formatDocumentTitle(title);

    // Restore original title on unmount
    return () => {
      if (originalTitleRef.current !== null) {
        document.title = originalTitleRef.current;
      }
    };
  }, [title, enabled]);
}

export default useDocumentTitle;
