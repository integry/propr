import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Circle } from 'lucide-react';
import { DetailedAnalysisData, parseAnalysis } from './AnalysisUtils';

interface ResultOverviewProps {
  analysis: DetailedAnalysisData | string | null;
  loading: boolean;
  renderMarkdown: (text: string) => React.ReactNode;
  totalThoughts?: number;
  detailedAnalysisExpanded?: boolean;
  onDetailedAnalysisToggle?: (expanded: boolean) => void;
}

// Lighthouse Geometric Pill - styled as [ ● 9 ]
export const GeometricScorePill: React.FC<{ score: number }> = ({ score }) => {
  let colorClasses: string;

  if (score >= 9) {
    colorClasses = 'text-teal-600';
  } else if (score >= 7) {
    colorClasses = 'text-slate-600';
  } else if (score >= 5) {
    colorClasses = 'text-amber-600';
  } else {
    colorClasses = 'text-red-600';
  }

  return (
    <div
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 ${colorClasses}`}
      title={`Score: ${score}/10`}
    >
      <Circle size={8} fill="currentColor" />
      <span className="font-mono text-xs font-bold">{score}</span>
    </div>
  );
};



// Collapsible accordion section - simple chevron toggle
const CollapsibleSection: React.FC<{
  children: React.ReactNode;
  defaultExpanded?: boolean;
  isExpanded?: boolean;
  onToggle?: (expanded: boolean) => void;
}> = ({ children, defaultExpanded = false, isExpanded: controlledExpanded, onToggle }) => {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);

  // Use controlled state if provided (is a boolean), otherwise use internal state
  const isExpanded = typeof controlledExpanded === 'boolean' ? controlledExpanded : internalExpanded;

  const handleToggle = () => {
    const newValue = !isExpanded;
    if (onToggle) {
      onToggle(newValue);
    } else {
      setInternalExpanded(newValue);
    }
  };

  return (
    <div className="border-t border-gray-100">
      <button
        onClick={handleToggle}
        className="flex items-center gap-1 py-2 text-left text-slate-400 hover:text-slate-600 transition-colors"
        title={isExpanded ? "Collapse details" : "Expand details"}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <span className="text-[11px] uppercase font-bold tracking-widest">Details</span>
      </button>
      {isExpanded && (
        <div className="pb-3 text-[13px] leading-relaxed text-gray-700 overflow-hidden">
          {children}
        </div>
      )}
    </div>
  );
};

// Section header with optional score pill (for inside accordion)
const SectionHeaderWithScore: React.FC<{
  title: string;
  score?: number;
}> = ({ title, score }) => (
  <div className="flex items-center gap-2 mb-1">
    <span className="text-[11px] uppercase font-bold text-slate-500 tracking-widest">
      {title}
    </span>
    {score !== undefined && <GeometricScorePill score={score} />}
  </div>
);


// Outcome Area Component
const OutcomeArea: React.FC<{
  summaryContent?: string;
  critiqueContent?: string;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ summaryContent, critiqueContent, renderMarkdown }) => {
  if (!summaryContent && !critiqueContent) return null;

  return (
    <div className="bg-slate-50 border-l-4 border-teal-600 px-4 py-3 mb-4 flex flex-col gap-6 overflow-hidden">
      {summaryContent && (
        <div>
          <div className="text-[11px] uppercase font-bold text-slate-500 tracking-widest mb-1">
            Summary of Changes
          </div>
          <div className="text-[13px] text-gray-700 leading-relaxed prose prose-sm max-w-none break-words overflow-hidden">
            {renderMarkdown(summaryContent)}
          </div>
        </div>
      )}
      {critiqueContent && (
        <div>
          <div className="text-[11px] uppercase font-bold text-slate-500 tracking-widest mb-1">
            Technical Review
          </div>
          <div className="text-[13px] text-gray-700 leading-relaxed prose prose-sm max-w-none break-words overflow-hidden">
            {renderMarkdown(critiqueContent)}
          </div>
        </div>
      )}
    </div>
  );
};

// Analysis Section Component
const AnalysisSection: React.FC<{
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <div>
    <div className="text-[11px] uppercase font-bold text-slate-500 tracking-widest mb-1">
      {title}
    </div>
    {children}
  </div>
);

// Recommendations List Component
const RecommendationsList: React.FC<{
  recommendations: string[];
}> = ({ recommendations }) => (
  <AnalysisSection title="Recommendations">
    <ul className="space-y-1">
      {recommendations.map((rec, idx) => (
        <li key={idx} className="flex items-start gap-2 text-[13px] leading-relaxed text-gray-700">
          <span className="mt-0.5 text-slate-400 flex-shrink-0">•</span>
          <span className="break-words min-w-0">{rec}</span>
        </li>
      ))}
    </ul>
  </AnalysisSection>
);

// Detailed Analysis Content Component
const DetailedAnalysisContent: React.FC<{
  parsed: DetailedAnalysisData;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ parsed, renderMarkdown }) => (
  <div className="space-y-3">
    {parsed.prompt_improvements && (
      <div className="overflow-hidden">
        <SectionHeaderWithScore title="Prompt Improvements" score={parsed.prompt_quality_score} />
        <p className="text-[13px] leading-relaxed text-gray-700 break-words">{parsed.prompt_improvements}</p>
      </div>
    )}

    {parsed.efficiency_notes && (
      <div className="overflow-hidden">
        <SectionHeaderWithScore title="Efficiency Notes" score={parsed.efficiency_score} />
        <p className="text-[13px] leading-relaxed text-gray-700 break-words">{parsed.efficiency_notes}</p>
      </div>
    )}

    {parsed.recommendations && parsed.recommendations.length > 0 && (
      <RecommendationsList recommendations={parsed.recommendations} />
    )}

    {parsed.error_analysis && (
      <AnalysisSection title="Error Analysis">
        <p className="text-[13px] leading-relaxed text-gray-700 break-words">{parsed.error_analysis}</p>
      </AnalysisSection>
    )}
  </div>
);

// Check if detailed content exists
const hasDetailedAnalysisContent = (parsed: DetailedAnalysisData): boolean => {
  return !!(
    parsed.prompt_improvements ||
    parsed.efficiency_notes ||
    (parsed.recommendations && parsed.recommendations.length > 0) ||
    parsed.error_analysis
  );
};

// Loading State Component
const LoadingState: React.FC = () => (
  <div className="py-2 text-gray-500 text-sm">Running analysis...</div>
);

// Analysis Content Component - handles parsed data rendering
const AnalysisContent: React.FC<{
  parsed: DetailedAnalysisData;
  renderMarkdown: (text: string) => React.ReactNode;
  totalThoughts: number;
  detailedAnalysisExpanded?: boolean;
  onDetailedAnalysisToggle?: (expanded: boolean) => void;
}> = ({ parsed, renderMarkdown, totalThoughts, detailedAnalysisExpanded, onDetailedAnalysisToggle }) => {
  const summaryContent = parsed.summary_of_changes || parsed.summary;
  const critiqueContent = parsed.implementation_critique;
  const shouldCollapseByDefault = totalThoughts > 10;
  const hasDetailedContent = hasDetailedAnalysisContent(parsed);

  return (
    <>
      <OutcomeArea 
        summaryContent={summaryContent} 
        critiqueContent={critiqueContent} 
        renderMarkdown={renderMarkdown} 
      />

      {hasDetailedContent && (
        <CollapsibleSection
          defaultExpanded={!shouldCollapseByDefault}
          isExpanded={detailedAnalysisExpanded}
          onToggle={onDetailedAnalysisToggle}
        >
          <DetailedAnalysisContent parsed={parsed} renderMarkdown={renderMarkdown} />
        </CollapsibleSection>
      )}
    </>
  );
};

const ResultOverview: React.FC<ResultOverviewProps> = ({
  analysis,
  loading,
  renderMarkdown,
  totalThoughts = 0,
  detailedAnalysisExpanded,
  onDetailedAnalysisToggle,
}) => {
  const parsed = parseAnalysis(analysis);

  if (!parsed && !loading) return null;

  return (
    <div className="bg-white border-b border-slate-200 min-w-0 overflow-hidden">
      <div className="p-4 min-w-0">
        {loading && <LoadingState />}
        {parsed && !loading && (
          <AnalysisContent
            parsed={parsed}
            renderMarkdown={renderMarkdown}
            totalThoughts={totalThoughts}
            detailedAnalysisExpanded={detailedAnalysisExpanded}
            onDetailedAnalysisToggle={onDetailedAnalysisToggle}
          />
        )}
      </div>
    </div>
  );
};

export default ResultOverview;