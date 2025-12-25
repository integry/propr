import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownRendererProps {
  text: unknown;
  className?: string;
}

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

  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks with syntax highlighting
          code({ inline, className, children, ...props }: { inline?: boolean; className?: string; children?: React.ReactNode }) {
            const match = /language-(\w+)/.exec(className || '');
            return !inline && match ? (
              <div className="my-2 relative group">
                <div className="absolute top-2 right-2 text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity z-10">
                  {match[1].toUpperCase()}
                </div>
                <SyntaxHighlighter
                  {...props}
                  style={vscDarkPlus}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{
                    borderRadius: '0.375rem',
                    fontSize: '0.875rem',
                    border: '1px solid #d1d5db',
                    margin: 0
                  }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            ) : (
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
        {text}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownRenderer;
