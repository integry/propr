import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * Detects the language identifier for a file based on its extension
 */
function getLanguageFromFilePath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'kt': 'kotlin',
    'cs': 'csharp',
    'cpp': 'cpp',
    'c': 'c',
    'h': 'c',
    'hpp': 'cpp',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
    'sql': 'sql',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'html': 'html',
    'xml': 'xml',
    'vue': 'vue',
    'svelte': 'svelte',
    'php': 'php',
    'swift': 'swift',
    'dart': 'dart'
  };
  return languageMap[ext] || 'text';
}

/**
 * Repairs implementation markdown to ensure code blocks are properly fenced.
 * (Copy of the function from planningHelpers.ts for standalone testing)
 */
function repairImplementationMarkdown(implementation: string): string {
  if (!implementation || typeof implementation !== 'string') {
    return implementation;
  }

  const lines = implementation.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const headerMatch = line.match(/^###\s*File:\s*`([^`]+)`(?:\s*\((new file)\))?/);

    if (headerMatch) {
      const filePath = headerMatch[1];
      const isNewFile = !!headerMatch[2];

      result.push(line);
      i++;

      while (i < lines.length && lines[i].trim() === '') {
        result.push(lines[i]);
        i++;
      }

      if (i >= lines.length) break;

      const nextLine = lines[i];
      const isAlreadyFenced = nextLine.trim().startsWith('```');

      if (isAlreadyFenced) {
        result.push(nextLine);
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          result.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          result.push(lines[i]);
          i++;
        }
      } else {
        const codeLines: string[] = [];
        let hasDiffMarkers = false;

        while (i < lines.length) {
          const codeLine = lines[i];
          if (codeLine.match(/^###\s*File:\s*`[^`]+`/)) {
            break;
          }
          if (codeLine.match(/^[-+@]{1,3}/) || codeLine.match(/^---\s+[ab]\//) || codeLine.match(/^\+\+\+\s+[ab]\//)) {
            hasDiffMarkers = true;
          }
          codeLines.push(codeLine);
          i++;
        }

        while (codeLines.length > 0 && codeLines[codeLines.length - 1].trim() === '') {
          codeLines.pop();
        }

        while (codeLines.length > 0 && codeLines[0].trim() === '') {
          codeLines.shift();
        }

        if (codeLines.length > 0) {
          let language: string;
          if (hasDiffMarkers) {
            language = 'diff';
          } else if (isNewFile) {
            language = getLanguageFromFilePath(filePath);
          } else {
            language = 'diff';
          }

          result.push('```' + language);
          result.push(...codeLines);
          result.push('```');
          result.push('');
        }
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

describe('repairImplementationMarkdown', () => {
  test('returns input unchanged if already properly fenced', () => {
    const input = `### File: \`src/utils/helper.ts\`

\`\`\`diff
--- a/src/utils/helper.ts
+++ b/src/utils/helper.ts
@@ -5,6 +5,8 @@
 export function existingFunc() {
+  // Add new logic here
+  return newValue;
 }
\`\`\``;

    const result = repairImplementationMarkdown(input);
    assert.strictEqual(result, input);
  });

  test('adds diff fencing to unfenced diff code after file header', () => {
    const input = `### File: \`src/utils/helper.ts\`

--- a/src/utils/helper.ts
+++ b/src/utils/helper.ts
@@ -5,6 +5,8 @@
 export function existingFunc() {
+  // Add new logic here
+  return newValue;
 }`;

    const expected = `### File: \`src/utils/helper.ts\`

\`\`\`diff
--- a/src/utils/helper.ts
+++ b/src/utils/helper.ts
@@ -5,6 +5,8 @@
 export function existingFunc() {
+  // Add new logic here
+  return newValue;
 }
\`\`\`
`;

    const result = repairImplementationMarkdown(input);
    assert.strictEqual(result, expected);
  });

  test('adds typescript fencing to unfenced new file code', () => {
    const input = `### File: \`src/utils/newHelper.ts\` (new file)

export function newHelper() {
  return 'hello';
}`;

    const expected = `### File: \`src/utils/newHelper.ts\` (new file)

\`\`\`typescript
export function newHelper() {
  return 'hello';
}
\`\`\`
`;

    const result = repairImplementationMarkdown(input);
    assert.strictEqual(result, expected);
  });

  test('detects correct language from file extension', () => {
    const input = `### File: \`src/styles/main.css\` (new file)

.container {
  display: flex;
}`;

    const result = repairImplementationMarkdown(input);
    assert.ok(result.includes('```css'), 'Should use css language identifier');
  });

  test('handles multiple file sections', () => {
    const input = `### File: \`src/utils/a.ts\`

--- a/src/utils/a.ts
+++ b/src/utils/a.ts
@@ -1,3 +1,4 @@
+// new comment
 existing line

### File: \`src/utils/b.ts\` (new file)

export const B = 'b';`;

    const result = repairImplementationMarkdown(input);

    // Both sections should be fenced
    const diffCount = (result.match(/```diff/g) || []).length;
    const tsCount = (result.match(/```typescript/g) || []).length;
    const closingCount = (result.match(/```\n/g) || []).length;

    assert.strictEqual(diffCount, 1, 'Should have one diff block');
    assert.strictEqual(tsCount, 1, 'Should have one typescript block');
    assert.strictEqual(closingCount, 2, 'Should have two closing fences');
  });

  test('handles empty input', () => {
    assert.strictEqual(repairImplementationMarkdown(''), '');
    assert.strictEqual(repairImplementationMarkdown(null as unknown as string), null);
    assert.strictEqual(repairImplementationMarkdown(undefined as unknown as string), undefined);
  });

  test('preserves content without file headers', () => {
    const input = `Some introductory text.

This is just regular markdown without file headers.`;

    const result = repairImplementationMarkdown(input);
    assert.strictEqual(result, input);
  });

  test('handles mixed properly-fenced and unfenced sections', () => {
    const input = `### File: \`src/a.ts\`

\`\`\`diff
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
+// added
\`\`\`

### File: \`src/b.ts\`

--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
+// also added`;

    const result = repairImplementationMarkdown(input);

    // Count fences - should have 2 diff blocks
    const diffCount = (result.match(/```diff/g) || []).length;
    assert.strictEqual(diffCount, 2, 'Should have two diff blocks');
  });

  test('uses diff language for existing files without explicit diff markers but with changes', () => {
    const input = `### File: \`src/utils/helper.ts\`

// This is code that should be modified
export function helper() {
  return true;
}`;

    const result = repairImplementationMarkdown(input);
    // Without diff markers, it should still default to diff for existing files
    assert.ok(result.includes('```diff'), 'Should default to diff for existing files');
  });

  test('correctly detects JavaScript files', () => {
    const input = `### File: \`src/index.js\` (new file)

module.exports = { foo: 'bar' };`;

    const result = repairImplementationMarkdown(input);
    assert.ok(result.includes('```javascript'), 'Should use javascript language identifier');
  });

  test('correctly detects Python files', () => {
    const input = `### File: \`scripts/main.py\` (new file)

def main():
    print("Hello")`;

    const result = repairImplementationMarkdown(input);
    assert.ok(result.includes('```python'), 'Should use python language identifier');
  });
});
