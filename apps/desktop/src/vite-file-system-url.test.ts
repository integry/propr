import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { viteFileSystemUrl } from './vite-file-system-url';

describe('Vite filesystem renderer URLs', () => {
  it('preserves an absolute POSIX path after the /@fs/ prefix', () => {
    assert.equal(
      viteFileSystemUrl('/home/propr/propr-ui/src/desktop.tsx'),
      '/@fs/home/propr/propr-ui/src/desktop.tsx',
    );
  });

  it('normalizes a Windows drive-letter path and separators', () => {
    assert.equal(
      viteFileSystemUrl('C:\\propr\\propr-ui\\src\\desktop.tsx'),
      '/@fs/C:/propr/propr-ui/src/desktop.tsx',
    );
  });
});
