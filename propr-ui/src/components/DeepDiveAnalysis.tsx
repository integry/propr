import React from 'react';

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
}

interface DeepDiveAnalysisProps {
  analysis: DeepDiveAnalysisData | string | null;
  loading: boolean;
  renderMarkdown?: (text: string) => React.ReactNode;
  title?: string;
  colorScheme?: 'purple' | 'gray';
  emptyStateText?: string;
}

interface ColorScheme {
  bg: string;
  border: string;
  cardBorder: string;
  text: string;
  heading: string;
  button: string;
  progress: string;
  badge: string;
  bullet: string;
}

const COLOR_SCHEMES: Record<'purple' | 'gray', ColorScheme> = {
  purple: {
    bg: 'bg-purple-50',
    border: 'border-purple-200',
    cardBorder: 'border-purple-300',
    text: 'text-purple-800',
    heading: 'text-purple-900',
    button: 'bg-purple-600 hover:bg-purple-700',
    progress: 'bg-purple-600',
    badge: 'bg-purple-100 text-purple-800',
    bullet: 'text-purple-600',
  },
  gray: {
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    cardBorder: 'border-gray-300',
    text: 'text-gray-800',
    heading: 'text-gray-900',
    button: 'bg-gray-600 hover:bg-gray-700',
    progress: 'bg-gray-600',
    badge: 'bg-gray-100 text-gray-800',
    bullet: 'text-gray-600',
  },
};

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

const Card: React.FC<{ scheme: ColorScheme; children: React.ReactNode }> = ({ scheme, children }) => (
  <div className={`bg-white rounded-lg p-4 border ${scheme.cardBorder}`}>{children}</div>
);

const ImplementationCritique: React.FC<{
  data: DeepDiveAnalysisData;
  scheme: ColorScheme;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ data, scheme, renderMarkdown }) => {
  if (!data.implementation_critique) return null;
  return (
    <Card scheme={scheme}>
      <div className="flex items-center gap-3 mb-2">
        {data.implementation_critique_score !== undefined && (
          <span className={`px-2 py-1 text-xs font-bold rounded ${scheme.badge}`}>
            {data.implementation_critique_score}/10
          </span>
        )}
        <h5 className={`font-semibold ${scheme.heading}`}>Implementation Critique</h5>
      </div>
      <div className="text-gray-700 text-sm prose prose-sm max-w-none">
        {renderMarkdown(data.implementation_critique)}
      </div>
    </Card>
  );
};

const PromptQuality: React.FC<{ data: DeepDiveAnalysisData; scheme: ColorScheme }> = ({ data, scheme }) => {
  if (data.prompt_quality_score === undefined) return null;
  return (
    <Card scheme={scheme}>
      <div className="flex items-center gap-3 mb-2">
        <span className={`px-2 py-1 text-xs font-bold rounded ${scheme.badge}`}>{data.prompt_quality_score}/10</span>
        <h5 className={`font-semibold ${scheme.heading}`}>Prompt Quality</h5>
      </div>
      {data.prompt_improvements && (
        <div>
          <p className="text-sm font-medium text-gray-700 mb-1">Suggested Improvements:</p>
          <p className="text-gray-700 text-sm">{data.prompt_improvements}</p>
        </div>
      )}
    </Card>
  );
};

const EfficiencyScore: React.FC<{ data: DeepDiveAnalysisData; scheme: ColorScheme }> = ({ data, scheme }) => {
  if (data.efficiency_score === undefined) return null;
  return (
    <Card scheme={scheme}>
      <div className="flex items-center gap-3 mb-2">
        <span className={`px-2 py-1 text-xs font-bold rounded ${scheme.badge}`}>{data.efficiency_score}/10</span>
        <h5 className={`font-semibold ${scheme.heading}`}>Efficiency</h5>
      </div>
      {data.efficiency_notes && <p className="text-gray-700 text-sm">{data.efficiency_notes}</p>}
    </Card>
  );
};

const Recommendations: React.FC<{ data: DeepDiveAnalysisData; scheme: ColorScheme }> = ({ data, scheme }) => {
  if (!data.recommendations || data.recommendations.length === 0) return null;
  return (
    <Card scheme={scheme}>
      <h5 className={`font-semibold mb-3 ${scheme.heading}`}>Recommendations</h5>
      <ul className="space-y-2">
        {data.recommendations.map((rec, idx) => (
          <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
            <span className={`mt-0.5 ${scheme.bullet}`}>•</span>
            <span>{rec}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
};

const ToolUsageSummary: React.FC<{ data: DeepDiveAnalysisData; scheme: ColorScheme }> = ({ data, scheme }) => {
  if (!data.tool_usage_summary) return null;
  return (
    <Card scheme={scheme}>
      <h5 className={`font-semibold mb-3 ${scheme.heading}`}>Tool Usage Summary</h5>
      {data.tool_usage_summary.most_used_tools && (
        <div className="mb-3">
          <p className="text-sm font-medium text-gray-700 mb-2">Most Used Tools:</p>
          <div className="flex flex-wrap gap-2">
            {data.tool_usage_summary.most_used_tools.map((tool, idx) => (
              <span key={idx} className={`px-3 py-1 rounded-full text-sm font-medium ${scheme.badge}`}>{tool}</span>
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
    </Card>
  );
};

const ErrorAnalysis: React.FC<{ data: DeepDiveAnalysisData; scheme: ColorScheme }> = ({ data, scheme }) => {
  if (!data.error_analysis) return null;
  return (
    <Card scheme={scheme}>
      <h5 className={`font-semibold mb-2 ${scheme.heading}`}>Error Analysis</h5>
      <p className="text-gray-700 text-sm">{data.error_analysis}</p>
    </Card>
  );
};

const StructuredContent: React.FC<{
  data: DeepDiveAnalysisData;
  scheme: ColorScheme;
  renderMarkdown: (text: string) => React.ReactNode;
}> = ({ data, scheme, renderMarkdown }) => (
  <div className="space-y-4">
    <ImplementationCritique data={data} scheme={scheme} renderMarkdown={renderMarkdown} />
    <PromptQuality data={data} scheme={scheme} />
    <EfficiencyScore data={data} scheme={scheme} />
    <Recommendations data={data} scheme={scheme} />
    <ToolUsageSummary data={data} scheme={scheme} />
    <ErrorAnalysis data={data} scheme={scheme} />
  </div>
);

interface AnalysisContentProps {
  actualAnalysis: DeepDiveAnalysisData | string | null;
  hasStructuredData: boolean;
  scheme: ColorScheme;
  renderMarkdown: (text: string) => React.ReactNode;
}

const AnalysisContent: React.FC<AnalysisContentProps> = ({ actualAnalysis, hasStructuredData, scheme, renderMarkdown }) => {
  if (typeof actualAnalysis === 'object' && actualAnalysis && 'error' in actualAnalysis && actualAnalysis.error) {
    return <div className="text-red-600">{actualAnalysis.error}</div>;
  }
  if (typeof actualAnalysis === 'string') {
    return <div>{renderMarkdown(actualAnalysis)}</div>;
  }
  if (hasStructuredData && actualAnalysis && typeof actualAnalysis === 'object') {
    return <StructuredContent data={actualAnalysis} scheme={scheme} renderMarkdown={renderMarkdown} />;
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
  scheme: ColorScheme;
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
  colorScheme = 'purple',
  emptyStateText = 'Automated analysis is pending...',
}) => {
  const scheme = COLOR_SCHEMES[colorScheme];
  const parsedAnalysis = parseAnalysis(analysis);
  const actualAnalysis = extractReportAnalysis(parsedAnalysis);
  const hasStructuredData = hasStructuredContent(actualAnalysis);

  return (
    <div className="mb-6">
      <Header
        title={title}
        parsedAnalysis={parsedAnalysis}
        scheme={scheme}
      />
      {loading && (
        <div className={`p-4 rounded-lg border ${scheme.bg} ${scheme.border}`}>
          <div className={scheme.text}>Running analysis...</div>
        </div>
      )}
      {actualAnalysis && !loading && (
        <div className={`space-y-4 p-4 rounded-lg border ${scheme.bg} ${scheme.border}`}>
          <AnalysisContent
            actualAnalysis={actualAnalysis}
            hasStructuredData={hasStructuredData}
            scheme={scheme}
            renderMarkdown={renderMarkdown}
          />
        </div>
      )}
      {!actualAnalysis && !loading && (
        <div className={`p-4 rounded-lg border ${scheme.bg} ${scheme.border}`}>
          <div className="text-gray-500 text-sm">{emptyStateText}</div>
        </div>
      )}
    </div>
  );
};

export default DeepDiveAnalysis;
