/**
 * Extract file paths from implementation markdown
 */
export const extractFilePaths = (implementation: string): string[] => {
  if (!implementation) return [];

  const filePaths: string[] = [];
  const lines = implementation.split('\n');

  for (const line of lines) {
    // Match patterns like: "File: path", "**File: path**", "### File: `path`", etc.
    const fileMatch = line.match(/^(?:#{1,6}\s+)?(?:\*\*)?File:\s*[`]?([^`\n]+?)[`]?(?:\*\*)?$/i);
    if (fileMatch) {
      filePaths.push(fileMatch[1].trim());
    }
  }

  // If no File: patterns found, try to extract from code block language hints
  if (filePaths.length === 0) {
    const codeBlockMatches = implementation.matchAll(/```(\w+)/g);
    for (const match of codeBlockMatches) {
      // Count code blocks as generic files
      filePaths.push(`(${match[1]} code block)`);
    }
  }

  return filePaths;
};
