/** Convert an absolute native path into Vite's cross-platform /@fs/ URL form. */
export const viteFileSystemUrl = (absolutePath: string): string => {
  const normalizedPath = absolutePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `/@fs/${normalizedPath}`;
};
