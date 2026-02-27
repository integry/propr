import { useEffect, useRef } from 'react';

const APP_NAME = 'ProPR';

/**
 * Custom hook for dynamic document title management.
 * Updates the browser's document title and restores the original title on unmount.
 *
 * @param title - The page-specific title to display (e.g., "Settings", "Task #123")
 *                If empty or undefined, only the app name "ProPR" will be shown.
 *
 * @example
 * // Shows "Settings | ProPR" in the browser tab
 * useDocumentTitle('Settings');
 *
 * @example
 * // Shows "ProPR" in the browser tab
 * useDocumentTitle('');
 */
export function useDocumentTitle(title?: string): void {
  const originalTitleRef = useRef<string | null>(null);

  useEffect(() => {
    // Store the original title on first mount
    if (originalTitleRef.current === null) {
      originalTitleRef.current = document.title;
    }

    // Format the new title
    const newTitle = title?.trim()
      ? `${title.trim()} | ${APP_NAME}`
      : APP_NAME;

    document.title = newTitle;

    // Restore original title on unmount
    return () => {
      if (originalTitleRef.current !== null) {
        document.title = originalTitleRef.current;
      }
    };
  }, [title]);
}

export default useDocumentTitle;
