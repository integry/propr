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

// Lighthouse-style geometric score pill
const LighthouseScorePill: React.FC<{ score: number; label: string }> = ({ score, label }) => {
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
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border ${colorClasses}`}
      title={`${label}: ${score}/10`}
    >
      <ShapeIcon size={10} fill="currentColor" />
      <span className="font-mono text-sm font-bold">{score}</span>
      <span className="text-[10px] uppercase font-medium opacity-70">{label}</span>
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
        <div className="pb-3 text-sm text-gray-700">
          {children}
        </div>
      )}
    </div>
  );
};

// Score Pills Row Component
const ScorePillsRow: React.FC<{
  critiqueScore?: number;
  promptScore?: number;
  efficiencyScore?: number;
}> = ({ critiqueScore, promptScore, efficiencyScore }) => {
  const hasScores = critiqueScore !== undefined || promptScore !== undefined || efficiencyScore !== undefined;

  if (!hasScores) return null;

  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap">
      {critiqueScore !== undefined && (
        <LighthouseScorePill score={critiqueScore} label="Critique" />
      )}
      {promptScore !== undefined && (
        <LighthouseScorePill score={promptScore} label="Prompt" />
      )}
      {efficiencyScore !== undefined && (
        <LighthouseScorePill score={efficiencyScore} label="Efficiency" />
      )}
    </div>
  );
};

// Summary Box Component
const SummaryBox: React.FC<{
  content: string;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ content, renderMarkdown }) => (
  <div className="bg-slate-50 border-l-2 border-teal-500 px-3 py-2 mb-3">
    <div className="text-[10px] uppercase font-bold text-slate-500 tracking-widest mb-1">
      Summary of Changes
    </div>
    <div className="text-sm text-gray-700 prose prose-sm max-w-none">
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
          <span className="mt-0.5 text-slate-400">•</span>
          <span>{rec}</span>
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
        <div className="prose prose-sm max-w-none">
          {renderMarkdown(parsed.implementation_critique)}
        </div>
      </AnalysisSection>
    )}

    {parsed.prompt_improvements && (
      <AnalysisSection title="Prompt Improvements">
        <p className="text-gray-700">{parsed.prompt_improvements}</p>
      </AnalysisSection>
    )}

    {parsed.efficiency_notes && (
      <AnalysisSection title="Efficiency Notes">
        <p className="text-gray-700">{parsed.efficiency_notes}</p>
      </AnalysisSection>
    )}

    {parsed.recommendations && parsed.recommendations.length > 0 && (
      <RecommendationsList recommendations={parsed.recommendations} />
    )}

    {parsed.error_analysis && (
      <AnalysisSection title="Error Analysis">
        <p className="text-gray-700">{parsed.error_analysis}</p>
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
      <ScorePillsRow
        critiqueScore={parsed.implementation_critique_score}
        promptScore={parsed.prompt_quality_score}
        efficiencyScore={parsed.efficiency_score}
      />

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
