import React from 'react';
import { ScoreBadge } from './TaskList/ScoreBadge';

interface DeepDiveAnalysisData {
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

interface DeepDiveAnalysisProps {
  analysis: DeepDiveAnalysisData | string | null;
  loading: boolean;
  renderMarkdown?: (text: string) => React.ReactNode;
  title?: string;
  colorScheme?: 'purple' | 'gray'; // Kept for backward compatibility, but no longer used
  emptyStateText?: string;
}

const MODEL_NAMES: Record<string, string> = {
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-opus-4-20250514': 'Claude Opus 4',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
};

const formatModelName = (modelId?: string): string => {
  if (!modelId) return 'Unknown Model';
  return MODEL_NAMES[modelId] || modelId;
};

const parseAnalysis = (analysis: DeepDiveAnalysisData | string | null): DeepDiveAnalysisData | string | null => {
  if (typeof analysis !== 'string') return analysis;
  
  try {
    const firstParse = JSON.parse(analysis);
    return typeof firstParse === 'string' ? JSON.parse(firstParse) : firstParse;
  } catch {
    return analysis;
  }
};

const extractReportAnalysis = (parsedAnalysis: DeepDiveAnalysisData | string | null): DeepDiveAnalysisData | string | null => {
  if (!parsedAnalysis || typeof parsedAnalysis !== 'object' || !parsedAnalysis.report) {
    return parsedAnalysis;
  }
  
  try {
    let reportText = parsedAnalysis.report;
    const jsonMatch = reportText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      reportText = jsonMatch[1].trim();
    }
    const reportParsed = JSON.parse(reportText);
    return { ...reportParsed, modelUsed: parsedAnalysis.modelUsed, generatedAt: parsedAnalysis.generatedAt };
  } catch {
    return parsedAnalysis;
  }
};

const hasStructuredContent = (analysis: DeepDiveAnalysisData | string | null): boolean => {
  if (!analysis || typeof analysis !== 'object' || 'error' in analysis) return false;
  return Boolean(
    analysis.efficiency_score !== undefined ||
    analysis.tool_usage_summary ||
    analysis.error_analysis ||
    analysis.prompt_quality_score !== undefined ||
    analysis.implementation_critique ||
    analysis.recommendations
  );
};

// Document-style section - no cards, just clean dividers
const Section: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="py-4 border-b border-gray-100 last:border-b-0">{children}</div>
);

// Utility header style for section titles
const SectionHeader: React.FC<{ title: string; score?: number }> = ({ title, score }) => (
  <div className="flex items-center gap-2 mb-2">
    <h5 className="text-[10px] uppercase font-bold text-slate-500 tracking-widest">{title}</h5>
    {score !== undefined && <ScoreBadge score={score} />}
  </div>
);

// Summary of Changes - Hero section at the top with highlighted styling
const SummaryOfChanges: React.FC<{
  data: DeepDiveAnalysisData;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ data, renderMarkdown }) => {
  const summaryContent = data.summary_of_changes || data.summary;
  if (!summaryContent) return null;

  return (
    <div className="mb-4 -mx-4 px-4 py-4 bg-slate-50 border-l-2 border-slate-300">
      <SectionHeader title="Summary of Changes" />
      <div className="text-gray-700 text-sm prose prose-sm max-w-none">
        {renderMarkdown(summaryContent)}
      </div>
    </div>
  );
};

const ImplementationCritique: React.FC<{
  data: DeepDiveAnalysisData;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ data, renderMarkdown }) => {
  if (!data.implementation_critique) return null;
  return (
    <Section>
      <SectionHeader title="Implementation Critique" score={data.implementation_critique_score} />
      <div className="text-gray-700 text-sm prose prose-sm max-w-none">
        {renderMarkdown(data.implementation_critique)}
      </div>
    </Section>
  );
};

const PromptQuality: React.FC<{ data: DeepDiveAnalysisData }> = ({ data }) => {
  if (data.prompt_quality_score === undefined) return null;
  return (
    <Section>
      <SectionHeader title="Prompt Quality" score={data.prompt_quality_score} />
      {data.prompt_improvements && (
        <div>
          <p className="text-sm font-medium text-gray-700 mb-1">Suggested Improvements:</p>
          <p className="text-gray-700 text-sm">{data.prompt_improvements}</p>
        </div>
      )}
    </Section>
  );
};

const EfficiencyScore: React.FC<{ data: DeepDiveAnalysisData }> = ({ data }) => {
  if (data.efficiency_score === undefined) return null;
  return (
    <Section>
      <SectionHeader title="Efficiency" score={data.efficiency_score} />
      {data.efficiency_notes && <p className="text-gray-700 text-sm">{data.efficiency_notes}</p>}
    </Section>
  );
};

const Recommendations: React.FC<{ data: DeepDiveAnalysisData }> = ({ data }) => {
  if (!data.recommendations || data.recommendations.length === 0) return null;
  return (
    <Section>
      <SectionHeader title="Recommendations" />
      <ul className="space-y-2">
        {data.recommendations.map((rec, idx) => (
          <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
            <span className="mt-0.5 text-slate-400">•</span>
            <span>{rec}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
};

const ToolUsageSummary: React.FC<{ data: DeepDiveAnalysisData }> = ({ data }) => {
  if (!data.tool_usage_summary) return null;
  return (
    <Section>
      <SectionHeader title="Tool Usage Summary" />
      {data.tool_usage_summary.most_used_tools && (
        <div className="mb-3">
          <p className="text-sm font-medium text-gray-700 mb-2">Most Used Tools:</p>
          <div className="flex flex-wrap gap-2">
            {data.tool_usage_summary.most_used_tools.map((tool, idx) => (
              <span key={idx} className="px-3 py-1 rounded-full text-sm font-medium bg-slate-100 text-slate-700">{tool}</span>
            ))}
          </div>
        </div>
      )}
      {data.tool_usage_summary.tool_appropriateness && (
        <div>
          <p className="text-sm font-medium text-gray-700 mb-1">Tool Appropriateness:</p>
          <p className="text-gray-700 text-sm">{data.tool_usage_summary.tool_appropriateness}</p>
        </div>
      )}
    </Section>
  );
};

const ErrorAnalysis: React.FC<{ data: DeepDiveAnalysisData }> = ({ data }) => {
  if (!data.error_analysis) return null;
  return (
    <Section>
      <SectionHeader title="Error Analysis" />
      <p className="text-gray-700 text-sm">{data.error_analysis}</p>
    </Section>
  );
};

const StructuredContent: React.FC<{
  data: DeepDiveAnalysisData;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ data, renderMarkdown }) => (
  <div>
    {/* Summary of Changes - Hero section at the top */}
    <SummaryOfChanges data={data} renderMarkdown={renderMarkdown} />
    {/* Analysis sections */}
    <ImplementationCritique data={data} renderMarkdown={renderMarkdown} />
    <PromptQuality data={data} />
    <EfficiencyScore data={data} />
    <Recommendations data={data} />
    <ToolUsageSummary data={data} />
    <ErrorAnalysis data={data} />
  </div>
);

interface AnalysisContentProps {
  actualAnalysis: DeepDiveAnalysisData | string | null;
  hasStructuredData: boolean;
  renderMarkdown: (text: string) => React.ReactNode;
}

const AnalysisContent: React.FC<AnalysisContentProps> = ({ actualAnalysis, hasStructuredData, renderMarkdown }) => {
  if (typeof actualAnalysis === 'object' && actualAnalysis && 'error' in actualAnalysis && actualAnalysis.error) {
    return <div className="text-red-600">{actualAnalysis.error}</div>;
  }
  if (typeof actualAnalysis === 'string') {
    return <div>{renderMarkdown(actualAnalysis)}</div>;
  }
  if (hasStructuredData && actualAnalysis && typeof actualAnalysis === 'object') {
    return <StructuredContent data={actualAnalysis} renderMarkdown={renderMarkdown} />;
  }
  return (
    <div className="text-sm text-gray-700">
      <pre className="whitespace-pre-wrap font-mono">{JSON.stringify(actualAnalysis, null, 2)}</pre>
    </div>
  );
};

interface HeaderProps {
  title: string;
  parsedAnalysis: DeepDiveAnalysisData | string | null;
}

const Header: React.FC<HeaderProps> = ({ title, parsedAnalysis }) => (
  <div className="flex items-center justify-between mb-4">
    <div className="flex items-center gap-3">
      <h4 className="text-lg font-semibold text-gray-900">{title}</h4>
      {parsedAnalysis && typeof parsedAnalysis === 'object' && parsedAnalysis.modelUsed && (
        <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800 font-medium">
          {formatModelName(parsedAnalysis.modelUsed)}
        </span>
      )}
    </div>
  </div>
);

const DeepDiveAnalysis: React.FC<DeepDiveAnalysisProps> = ({
  analysis,
  loading,
  renderMarkdown = (text) => text,
  title = 'Execution Analysis',
  colorScheme: _colorScheme, // Kept for backward compatibility
  emptyStateText = 'Automated analysis is pending...',
}) => {
  void _colorScheme; // Suppress unused variable warning
  const parsedAnalysis = parseAnalysis(analysis);
  const actualAnalysis = extractReportAnalysis(parsedAnalysis);
  const hasStructuredData = hasStructuredContent(actualAnalysis);

  return (
    <div className="mb-6">
      <Header
        title={title}
        parsedAnalysis={parsedAnalysis}
      />
      {loading && (
        <div className="py-4 text-gray-600 text-sm">Running analysis...</div>
      )}
      {actualAnalysis && !loading && (
        <AnalysisContent
          actualAnalysis={actualAnalysis}
          hasStructuredData={hasStructuredData}
          renderMarkdown={renderMarkdown}
        />
      )}
      {!actualAnalysis && !loading && (
        <div className="py-4 text-gray-500 text-sm">{emptyStateText}</div>
      )}
    </div>
  );
};

export default DeepDiveAnalysis;
