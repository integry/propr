import { useEffect, useRef } from 'react';

/** Custom hook that debounces a value and calls a callback when it changes */
export function useDebouncedCallback<T>(
  value: T,
  callback: (value: T) => void,
  delay: number
): void {
  const previousValue = useRef(value);

  useEffect(() => {
    if (value === previousValue.current) return;

    const timer = setTimeout(() => {
      previousValue.current = value;
      callback(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, callback, delay]);
}
