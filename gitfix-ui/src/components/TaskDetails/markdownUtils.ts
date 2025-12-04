import { MarkdownPart } from './types';

export const escapeHtml = (str: string): string => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

export const parseMarkdownParts = (text: string): MarkdownPart[] => {
  const parts: MarkdownPart[] = [];
  let lastIndex = 0;
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const beforeText = text.substring(lastIndex, match.index);
      parts.push({ type: 'text', content: beforeText });
    }

    const language = match[1] || 'javascript';
    let code = match[2];
    if (code.endsWith('\n')) {
      code = code.slice(0, -1);
    }
    parts.push({ type: 'code', language, content: code });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.substring(lastIndex) });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text', content: text });
  }

  return parts;
};

export const formatTextContent = (content: string): string => {
  let formatted = typeof content === 'string' ? content : String(content || '');
  formatted = formatted.replace(/\n{3,}/g, '\n\n');
  formatted = formatted.replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold text-gray-900 mt-4 mb-2">$1</h2>');
  formatted = formatted.replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold text-gray-800 mt-3 mb-1">$1</h3>');
  formatted = formatted.replace(/^#### (.+)$/gm, '<h4 class="text-sm font-semibold text-gray-700 mt-2 mb-1">$1</h4>');
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>');
  formatted = formatted.replace(/\*(.+?)\*/g, '<em class="italic">$1</em>');
  formatted = formatted.replace(/`([^`]+)`/g, (_match, code) => {
    return `<code class="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono border border-gray-300">${escapeHtml(code)}</code>`;
  });
  formatted = formatted.replace(/^- (.+)$/gm, '<li class="ml-4">$1</li>');
  formatted = formatted.replace(/(<li.*<\/li>\n?)+/g, '<ul class="list-disc list-inside space-y-1 my-2">$&</ul>');
  formatted = formatted.replace(/\n/g, '<br>');
  formatted = formatted.replace(/(\<\/(li|ul|ol|h2|h3|h4|h5|strong|em|code)\>)<br>/gi, '$1');
  formatted = formatted.replace(/(<br[^>]*>\s*){2,}/gi, '<br>');
  return formatted;
};
