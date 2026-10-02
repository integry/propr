import React from 'react';

const SummaryOfChanges: React.FC<{
  summaryContent?: string;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ summaryContent, renderMarkdown }) => {
  if (!summaryContent) return null;

  return (
    <div className="bg-slate-50 border-l-4 border-teal-600 px-4 py-3 overflow-hidden">
      <div className="text-[11px] uppercase font-bold text-teal-700 tracking-widest mb-2">
        Summary of Changes
      </div>
      <div className="text-[13px] text-gray-700 leading-relaxed prose prose-sm max-w-none break-words overflow-hidden prose-li:marker:text-teal-600">
        {renderMarkdown(summaryContent)}
      </div>
    </div>
  );
};

interface ResultOverviewProps {
  extractedSummary?: string | null;
  renderMarkdown: (text: string) => React.ReactNode;
}

const ResultOverview: React.FC<ResultOverviewProps> = ({ extractedSummary, renderMarkdown }) => {
  if (!extractedSummary) return null;
  return (
    <div data-testid="task-summary" className="bg-white border-b border-slate-200 min-w-0 overflow-hidden">
      <div className="p-4 min-w-0">
        <SummaryOfChanges summaryContent={extractedSummary} renderMarkdown={renderMarkdown} />
      </div>
    </div>
  );
};

export default ResultOverview;
