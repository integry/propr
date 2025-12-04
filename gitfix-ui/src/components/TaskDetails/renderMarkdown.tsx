import React from 'react';
import MarkdownRenderer from './MarkdownRenderer';

export const renderMarkdown = (text: unknown): React.ReactNode => {
  return <MarkdownRenderer text={text} />;
};
