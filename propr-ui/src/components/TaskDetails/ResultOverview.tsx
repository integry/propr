import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Diamond, Square, Triangle } from 'lucide-react';

interface AnalysisData {
  efficiency_score?: number;
  efficiency_notes?: string;
  tool_usage_summary?: {
    most_used_tools?: string[];
    tool_appropriateness?: string;
  };
  error_analysis?: string;
  prompt_quality_score?: number;
  prompt_improvements?: string;
  implementation_critique?: string;
  implementation_critique_score?: number;
  recommendations?: string[];
  error?: string;
  report?: string;
  modelUsed?: string;
  generatedAt?: string;
  summary_of_changes?: string;
  summary?: string;
}

interface ResultOverviewProps {
  analysis: AnalysisData | string | null;
  loading: boolean;
  renderMarkdown: (text: string) => React.ReactNode;
  totalThoughts?: number;
}

// Parse analysis (handle double-encoded JSON)
const parseAnalysis = (analysis: AnalysisData | string | null): AnalysisData | null => {
  if (!analysis) return null;
  if (typeof analysis !== 'string') return analysis;

  try {
    const firstParse = JSON.parse(analysis);
    const parsed = typeof firstParse === 'string' ? JSON.parse(firstParse) : firstParse;

    // Extract from report field if present
    if (parsed && typeof parsed === 'object' && parsed.report) {
      try {
        let reportText = parsed.report;
        const jsonMatch = reportText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          reportText = jsonMatch[1].trim();
        }
        return { ...JSON.parse(reportText), modelUsed: parsed.modelUsed, generatedAt: parsed.generatedAt };
      } catch {
        return parsed;
      }
    }
    return parsed;
  } catch {
    return null;
  }
};

// Geometric score pill (compact version for inline use)
const GeometricScorePill: React.FC<{ score: number }> = ({ score }) => {
  let colorClasses: string;
  let ShapeIcon: typeof Triangle;

  if (score >= 9) {
    colorClasses = 'bg-teal-50 text-teal-600 border-teal-200';
    ShapeIcon = Circle;
  } else if (score >= 7) {
    colorClasses = 'bg-slate-100 text-slate-600 border-slate-200';
    ShapeIcon = Diamond;
  } else if (score >= 5) {
    colorClasses = 'bg-amber-50 text-amber-600 border-amber-200';
    ShapeIcon = Square;
  } else {
    colorClasses = 'bg-red-50 text-red-600 border-red-200';
    ShapeIcon = Triangle;
  }

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border ${colorClasses}`}
      title={`Score: ${score}/10`}
    >
      <ShapeIcon size={10} fill="currentColor" />
      <span className="font-mono text-sm font-bold">{score}</span>
    </div>
  );
};

// Primary Implementation Header with single score
const ImplementationHeader: React.FC<{ score?: number }> = ({ score }) => {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-3">
        <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest">
          Implementation
        </span>
        {score !== undefined && <GeometricScorePill score={score} />}
      </div>
    </div>
  );
};

// Collapsible accordion section
const CollapsibleSection: React.FC<{
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}> = ({ title, children, defaultExpanded = false }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="border-t border-gray-100">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 w-full py-2 text-left text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="uppercase font-bold tracking-wider">{title}</span>
      </button>
      {isExpanded && (
        <div className="pb-3 text-sm text-gray-700 overflow-hidden">
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
    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest">
      {title}
    </span>
    {score !== undefined && <GeometricScorePill score={score} />}
  </div>
);


// Summary Box Component
const SummaryBox: React.FC<{
  content: string;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ content, renderMarkdown }) => (
  <div className="bg-slate-50 border-l-2 border-teal-500 px-3 py-2 mb-3 overflow-hidden">
    <div className="text-[10px] uppercase font-bold text-slate-500 tracking-widest mb-1">
      Summary of Changes
    </div>
    <div className="text-sm text-gray-700 prose prose-sm max-w-none break-words overflow-hidden">
      {renderMarkdown(content)}
    </div>
  </div>
);

// Analysis Section Component
const AnalysisSection: React.FC<{
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <div>
    <div className="text-[10px] uppercase font-bold text-slate-500 tracking-widest mb-1">
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
        <li key={idx} className="flex items-start gap-2 text-gray-700">
          <span className="mt-0.5 text-slate-400 flex-shrink-0">•</span>
          <span className="break-words min-w-0">{rec}</span>
        </li>
      ))}
    </ul>
  </AnalysisSection>
);

// Detailed Analysis Content Component
const DetailedAnalysisContent: React.FC<{
  parsed: AnalysisData;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ parsed, renderMarkdown }) => (
  <div className="space-y-3">
    {parsed.implementation_critique && (
      <AnalysisSection title="Implementation Critique">
        <div className="prose prose-sm max-w-none break-words overflow-hidden">
          {renderMarkdown(parsed.implementation_critique)}
        </div>
      </AnalysisSection>
    )}

    {parsed.prompt_improvements && (
      <div className="overflow-hidden">
        <SectionHeaderWithScore title="Prompt Improvements" score={parsed.prompt_quality_score} />
        <p className="text-gray-700 break-words">{parsed.prompt_improvements}</p>
      </div>
    )}

    {parsed.efficiency_notes && (
      <div className="overflow-hidden">
        <SectionHeaderWithScore title="Efficiency Notes" score={parsed.efficiency_score} />
        <p className="text-gray-700 break-words">{parsed.efficiency_notes}</p>
      </div>
    )}

    {parsed.recommendations && parsed.recommendations.length > 0 && (
      <RecommendationsList recommendations={parsed.recommendations} />
    )}

    {parsed.error_analysis && (
      <AnalysisSection title="Error Analysis">
        <p className="text-gray-700 break-words">{parsed.error_analysis}</p>
      </AnalysisSection>
    )}
  </div>
);

// Check if detailed content exists
const hasDetailedAnalysisContent = (parsed: AnalysisData): boolean => {
  return !!(
    parsed.implementation_critique ||
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
  parsed: AnalysisData;
  renderMarkdown: (text: string) => React.ReactNode;
  totalThoughts: number;
}> = ({ parsed, renderMarkdown, totalThoughts }) => {
  const summaryContent = parsed.summary_of_changes || parsed.summary;
  const shouldCollapseByDefault = totalThoughts > 10;
  const hasDetailedContent = hasDetailedAnalysisContent(parsed);

  return (
    <>
      <ImplementationHeader score={parsed.implementation_critique_score} />

      {summaryContent && (
        <SummaryBox content={summaryContent} renderMarkdown={renderMarkdown} />
      )}

      {hasDetailedContent && (
        <CollapsibleSection
          title="View Detailed Analysis"
          defaultExpanded={!shouldCollapseByDefault}
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
}) => {
  const parsed = parseAnalysis(analysis);

  if (!parsed && !loading) return null;

  return (
    <div className="bg-white border-b border-gray-200">
      <div className="p-4">
        {loading && <LoadingState />}
        {parsed && !loading && (
          <AnalysisContent
            parsed={parsed}
            renderMarkdown={renderMarkdown}
            totalThoughts={totalThoughts}
          />
        )}
      </div>
    </div>
  );
};

export default ResultOverview;
