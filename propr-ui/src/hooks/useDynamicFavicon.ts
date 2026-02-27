import { useEffect, useRef } from 'react';

// Teal color matching the sidebar badge style
const TEAL_COLOR = '#1D8A8A';
const FAVICON_SIZE = 32;

/**
 * Custom hook for dynamic favicon management based on active task count.
 * Updates the browser's favicon to show a teal circle with the count number.
 *
 * @param count - The number of active tasks to display
 *                - 0: Shows the default favicon
 *                - 1-9: Shows a teal circle with the number
 *                - >9: Shows a teal circle with "9+"
 *
 * @example
 * // Shows default favicon
 * useDynamicFavicon(0);
 *
 * @example
 * // Shows teal circle with "5"
 * useDynamicFavicon(5);
 *
 * @example
 * // Shows teal circle with "9+"
 * useDynamicFavicon(15);
 */
export function useDynamicFavicon(count: number): void {
  const originalFaviconRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const faviconElement = document.getElementById('favicon') as HTMLLinkElement | null;
    if (!faviconElement) return;

    // Store the original favicon URL on first mount
    if (originalFaviconRef.current === null) {
      originalFaviconRef.current = faviconElement.href;
    }

    // If count is 0, revert to default favicon
    if (count === 0) {
      if (originalFaviconRef.current) {
        faviconElement.href = originalFaviconRef.current;
      }
      return;
    }

    // Create canvas if it doesn't exist
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = FAVICON_SIZE;
      canvasRef.current.height = FAVICON_SIZE;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, FAVICON_SIZE, FAVICON_SIZE);

    // Draw teal circle
    ctx.beginPath();
    ctx.arc(FAVICON_SIZE / 2, FAVICON_SIZE / 2, FAVICON_SIZE / 2, 0, Math.PI * 2);
    ctx.fillStyle = TEAL_COLOR;
    ctx.fill();

    // Draw white text
    const displayText = count > 9 ? '9+' : String(count);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Adjust font size based on text length
    const fontSize = count > 9 ? 14 : 18;
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

    ctx.fillText(displayText, FAVICON_SIZE / 2, FAVICON_SIZE / 2 + 1);

    // Update favicon with canvas data URL
    faviconElement.href = canvas.toDataURL('image/png');

    // Cleanup: revert to original favicon on unmount
    return () => {
      if (originalFaviconRef.current && faviconElement) {
        faviconElement.href = originalFaviconRef.current;
      }
    };
  }, [count]);
}

export default useDynamicFavicon;
