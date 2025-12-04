import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { parseMarkdownParts, formatTextContent } from './markdownUtils';

interface CodeBlockProps {
  language: string;
  content: string;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ language, content }) => {
  const languageLabel = language.charAt(0).toUpperCase() + language.slice(1);
  return (
    <div className="my-2 relative">
      <div className="absolute top-2 right-2 text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded z-10">
        {languageLabel}
      </div>
      <SyntaxHighlighter
        language={language}
        style={vscDarkPlus}
        customStyle={{
          borderRadius: '0.375rem',
          fontSize: '0.875rem',
          border: '1px solid #d1d5db',
          margin: 0
        }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
};

interface MarkdownRendererProps {
  text: unknown;
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ text }) => {
  if (!text) return null;

  if (typeof text !== 'string') {
    if (typeof text === 'object') {
      const obj = text as Record<string, unknown>;
      if (obj.report) return <MarkdownRenderer text={obj.report} />;
      if (obj.analysis) return <MarkdownRenderer text={obj.analysis} />;
      if (obj.content) return <MarkdownRenderer text={obj.content} />;
      return (
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-700 bg-gray-50 p-4 rounded-md border border-gray-200">
          {JSON.stringify(text, null, 2)}
        </pre>
      );
    }
    return <>{String(text)}</>;
  }

  const parts = parseMarkdownParts(text);

  return (
    <div>
      {parts.map((part, index) => {
        if (part.type === 'code' && part.language) {
          return <CodeBlock key={index} language={part.language} content={part.content} />;
        }
        const formatted = formatTextContent(part.content);
        return <span key={index} dangerouslySetInnerHTML={{ __html: formatted }} />;
      })}
    </div>
  );
};

export default MarkdownRenderer;
