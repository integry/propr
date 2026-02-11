import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { FileText } from 'lucide-react';

interface MarkdownRendererProps {
  text: unknown;
  className?: string;
}

// Helper to check if a line starts a code block (supports both ``` and ~~~)
const isCodeBlockDelimiter = (line: string): boolean => {
  return line.startsWith('```') || line.startsWith('~~~');
};

// Helper to extract file path from markdown and clean the content
const preprocessMarkdown = (text: string): { processedText: string; filePathMap: Map<number, string> } => {
  const filePathMap = new Map<number, string>();
  const lines = text.split('\n');
  const processedLines: string[] = [];
  let codeBlockIndex = 0;
  let pendingFilePath: string | null = null;
  const linesToSkip = new Set<number>();

  // First pass: identify File: lines and their associated code blocks
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check if this is a "File: path" line
    // Supports: "File: path", "**File: path**", "### File: `path`", "#### File: `path`", etc.
    // Also handles backticks around the path
    const fileMatch = line.match(/^(?:#{1,6}\s+)?(?:\*\*)?File:\s*[`]?([^`\n]+?)[`]?(?:\*\*)?$/i);
    if (fileMatch) {
      const extractedPath = fileMatch[1].trim();
      // Look ahead for a code block (may have empty lines or other content between)
      for (let j = i + 1; j < lines.length && j <= i + 10; j++) {
        if (isCodeBlockDelimiter(lines[j])) {
          // Found a code block - mark this File: line for removal
          linesToSkip.add(i);
          pendingFilePath = extractedPath;
          break;
        }
        // If we hit another File: line or significant content, stop looking
        if (lines[j].match(/^(?:#{1,6}\s+)?(?:\*\*)?File:/i) ||
            (lines[j].trim() !== '' && !isCodeBlockDelimiter(lines[j]) && j > i + 3)) {
          break;
        }
      }
    }
  }

  // Reset pending file path for second pass
  pendingFilePath = null;

  // Second pass: build processed lines and track code blocks
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for File: pattern and extract path for next code block
    const fileMatch = line.match(/^(?:#{1,6}\s+)?(?:\*\*)?File:\s*[`]?([^`\n]+?)[`]?(?:\*\*)?$/i);
    if (fileMatch && linesToSkip.has(i)) {
      pendingFilePath = fileMatch[1].trim();
      continue; // Skip this line
    }

    // Track code blocks - when we encounter an opening code block, associate pending file path
    // Supports both ``` and ~~~ delimiters
    const isBacktickDelimiter = line.startsWith('```') && !line.slice(3).includes('```');
    const isTildeDelimiter = line.startsWith('~~~') && !line.slice(3).includes('~~~');
    if (isBacktickDelimiter || isTildeDelimiter) {
      // Check if this is opening a code block (not inline)
      const countDelimiters = processedLines.filter(l =>
        (l.startsWith('```') && !l.slice(3).includes('```')) ||
        (l.startsWith('~~~') && !l.slice(3).includes('~~~'))
      ).length;
      const isOpening = countDelimiters % 2 === 0;
      if (isOpening) {
        codeBlockIndex++;
        if (pendingFilePath) {
          filePathMap.set(codeBlockIndex, pendingFilePath);
          pendingFilePath = null;
        }
      }
    }

    processedLines.push(line);
  }

  return { processedText: processedLines.join('\n'), filePathMap };
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ text, className = '' }) => {
  if (!text) return null;

  // Handle non-string content (JSON objects)
  if (typeof text !== 'string') {
    if (typeof text === 'object' && text !== null) {
      const obj = text as Record<string, unknown>;
      if (obj.report) return <MarkdownRenderer text={obj.report} className={className} />;
      if (obj.analysis) return <MarkdownRenderer text={obj.analysis} className={className} />;
      if (obj.content) return <MarkdownRenderer text={obj.content} className={className} />;

      return (
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-700 bg-gray-50 p-4 rounded-md border border-gray-200 overflow-x-auto">
          {JSON.stringify(text, null, 2)}
        </pre>
      );
    }
    return <>{String(text)}</>;
  }

  // Preprocess to extract file paths
  const { processedText, filePathMap } = preprocessMarkdown(text);
  let codeBlockCounter = 0;

  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks with syntax highlighting - VS Code window style
          code({ inline, className, children, ...props }: { inline?: boolean; className?: string; children?: React.ReactNode }) {
            const match = /language-(\w+)/.exec(className || '');
            if (!inline && match) {
              codeBlockCounter++;
              const currentIndex = codeBlockCounter;
              const filePath = filePathMap.get(currentIndex);
              const codeContent = String(children).replace(/\n$/, '');

              // Extract directory path and filename
              const pathParts = filePath ? filePath.split('/') : [];
              const fileName = pathParts.length > 0 ? pathParts.pop() : '';
              const dirPath = pathParts.length > 0 ? pathParts.join('/') : '';

              return (
                <div className="code-block-container my-6 rounded-lg border border-gray-700 overflow-hidden shadow-md">
                  {/* VS Code style header bar with path/filename in 2 rows on left, type on right */}
                  <div className="bg-gray-800 px-3 py-2 flex items-center justify-between border-b border-gray-700">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {filePath && (
                        <>
                          <FileText size={12} className="text-gray-400 flex-shrink-0 self-start mt-0.5" />
                          <div className="flex flex-col min-w-0">
                            {dirPath && (
                              <span className="text-gray-500 text-xs font-mono truncate">{dirPath}/</span>
                            )}
                            <span className="text-gray-200 text-xs font-mono truncate">{fileName}</span>
                          </div>
                        </>
                      )}
                    </div>
                    <span className="text-gray-500 text-xs font-mono uppercase flex-shrink-0 ml-4">{match[1]}</span>
                  </div>
                  {/* Code body with dark background */}
                  <SyntaxHighlighter
                    {...props}
                    style={vscDarkPlus}
                    language={match[1]}
                    PreTag="div"
                    showLineNumbers={true}
                    lineNumberStyle={{
                      color: '#6b7280',
                      paddingRight: '0.75em',
                      paddingLeft: '0.75em',
                      marginLeft: 0,
                      minWidth: '2em',
                      textAlign: 'right',
                    }}
                    customStyle={{
                      borderRadius: 0,
                      fontSize: '0.875rem',
                      border: 'none',
                      margin: 0,
                      padding: '0.75rem 0',
                      backgroundColor: '#1E1E1E',
                      maxHeight: '300px',
                      overflowY: 'auto',
                    }}
                    codeTagProps={{
                      style: {
                        backgroundColor: 'transparent',
                      },
                    }}
                    className="code-block-scrollbar [&_span]:!bg-transparent [&_.linenumber]:!pl-0 [&_.linenumber]:!ml-0"
                  >
                    {codeContent}
                  </SyntaxHighlighter>
                </div>
              );
            }
            return (
              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono border border-gray-300 text-gray-800" {...props}>
                {children}
              </code>
            );
          },
          // Typography mappings to match original design
          h1: ({ children }) => <h1 className="text-xl font-bold text-gray-900 mt-6 mb-3">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-bold text-gray-900 mt-5 mb-3">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">{children}</h3>,
          h4: ({ children }) => <h4 className="text-sm font-semibold text-gray-700 mt-3 mb-1">{children}</h4>,
          p: ({ children }) => <p className="mb-4 text-gray-700 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc list-inside space-y-2 my-4 ml-2">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside space-y-2 my-4 ml-2">{children}</ol>,
          li: ({ children }) => <li className="ml-2 mb-1 text-gray-700">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-gray-300 pl-4 italic my-4 text-gray-600">
              {children}
            </blockquote>
          ),
          // Table styling with borders, padding, and visual separation
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="min-w-full border-collapse border border-gray-300 rounded-md">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-gray-100">
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-gray-200">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-gray-50">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border border-gray-300 bg-gray-100">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-2 text-sm text-gray-700 border border-gray-300">
              {children}
            </td>
          ),
        }}
      >
        {processedText}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownRenderer;
