import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Register cleanup for every test file, retaining the same RTL instance used
// by static render imports even when a test resets application modules.
afterEach(() => {
  cleanup();
});
