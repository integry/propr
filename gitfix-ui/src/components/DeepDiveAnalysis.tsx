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
  recommendations?: string[];
  error?: string;
}

interface DeepDiveAnalysisProps {
  analysis: DeepDiveAnalysisData | string | null;
  loading: boolean;
  onRunAnalysis?: () => void;
  renderMarkdown?: (text: string) => React.ReactNode;
  title?: string;
  buttonText?: string;
  colorScheme?: 'purple' | 'gray';
  showButton?: boolean;
  emptyStateText?: string;
}

const DeepDiveAnalysis: React.FC<DeepDiveAnalysisProps> = ({
  analysis,
  loading,
  onRunAnalysis,
  renderMarkdown = (text) => text,
  title = 'Deep-Dive Analysis (Advanced Model)',
  buttonText = 'Run Deep-Dive Analysis',
  colorScheme = 'purple',
  showButton = true,
  emptyStateText = 'Click "Run Deep-Dive Analysis" to generate an in-depth analysis using the advanced model.',
}) => {
  const colors = {
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

  const scheme = colors[colorScheme];

  let parsedAnalysis: DeepDiveAnalysisData | string | null = analysis;
  if (typeof analysis === 'string') {
    try {
      const firstParse = JSON.parse(analysis);
      if (typeof firstParse === 'string') {
        parsedAnalysis = JSON.parse(firstParse);
      } else {
        parsedAnalysis = firstParse;
      }
    } catch (e) {
      parsedAnalysis = analysis;
    }
  }

  const hasStructuredData = parsedAnalysis && typeof parsedAnalysis === 'object' && 
    !('error' in parsedAnalysis) &&
    (parsedAnalysis.efficiency_score !== undefined || 
     parsedAnalysis.tool_usage_summary !== undefined ||
     parsedAnalysis.error_analysis !== undefined ||
     parsedAnalysis.prompt_quality_score !== undefined ||
     parsedAnalysis.recommendations !== undefined);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-lg font-semibold text-gray-900">{title}</h4>
        {showButton && onRunAnalysis && (
          <button
            onClick={onRunAnalysis}
            disabled={loading}
            className={`px-3 py-1.5 text-white text-sm rounded-md transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed ${scheme.button}`}
          >
            {loading ? 'Analyzing...' : buttonText}
          </button>
        )}
      </div>
      {loading && (
        <div className={`p-4 rounded-lg border ${scheme.bg} ${scheme.border}`}>
          <div className={scheme.text}>Running analysis...</div>
        </div>
      )}
      {parsedAnalysis && !loading && (
        <div className={`space-y-4 p-4 rounded-lg border ${scheme.bg} ${scheme.border}`}>
          {typeof parsedAnalysis === 'object' && 'error' in parsedAnalysis && parsedAnalysis.error ? (
            <div className="text-red-600">{parsedAnalysis.error}</div>
          ) : typeof parsedAnalysis === 'string' ? (
            <div>{renderMarkdown(parsedAnalysis)}</div>
          ) : hasStructuredData ? (
            <div className="space-y-4">
              {parsedAnalysis.efficiency_score !== undefined && (
                <div className={`bg-white rounded-lg p-4 border ${scheme.cardBorder}`}>
                  <h5 className={`font-semibold mb-2 ${scheme.heading}`}>Efficiency Score</h5>
                  <div className="flex items-center gap-3">
                    <div className={`text-3xl font-bold ${scheme.heading}`}>
                      {parsedAnalysis.efficiency_score}/10
                    </div>
                    <div className="flex-1 bg-gray-200 rounded-full h-3">
                      <div 
                        className={`h-3 rounded-full transition-all ${scheme.progress}`}
                        style={{ width: `${parsedAnalysis.efficiency_score * 10}%` }}
                      />
                    </div>
                  </div>
                  {parsedAnalysis.efficiency_notes && (
                    <p className="text-gray-700 mt-3 text-sm">{parsedAnalysis.efficiency_notes}</p>
                  )}
                </div>
              )}

              {parsedAnalysis.tool_usage_summary && (
                <div className={`bg-white rounded-lg p-4 border ${scheme.cardBorder}`}>
                  <h5 className={`font-semibold mb-3 ${scheme.heading}`}>Tool Usage Summary</h5>
                  {parsedAnalysis.tool_usage_summary.most_used_tools && (
                    <div className="mb-3">
                      <p className="text-sm font-medium text-gray-700 mb-2">Most Used Tools:</p>
                      <div className="flex flex-wrap gap-2">
                        {parsedAnalysis.tool_usage_summary.most_used_tools.map((tool, idx) => (
                          <span key={idx} className={`px-3 py-1 rounded-full text-sm font-medium ${scheme.badge}`}>
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {parsedAnalysis.tool_usage_summary.tool_appropriateness && (
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-1">Tool Appropriateness:</p>
                      <p className="text-gray-700 text-sm">{parsedAnalysis.tool_usage_summary.tool_appropriateness}</p>
                    </div>
                  )}
                </div>
              )}

              {parsedAnalysis.error_analysis && (
                <div className={`bg-white rounded-lg p-4 border ${scheme.cardBorder}`}>
                  <h5 className={`font-semibold mb-2 ${scheme.heading}`}>Error Analysis</h5>
                  <p className="text-gray-700 text-sm">{parsedAnalysis.error_analysis}</p>
                </div>
              )}

              {parsedAnalysis.prompt_quality_score !== undefined && (
                <div className={`bg-white rounded-lg p-4 border ${scheme.cardBorder}`}>
                  <h5 className={`font-semibold mb-2 ${scheme.heading}`}>Prompt Quality Score</h5>
                  <div className="flex items-center gap-3">
                    <div className={`text-3xl font-bold ${scheme.heading}`}>
                      {parsedAnalysis.prompt_quality_score}/10
                    </div>
                    <div className="flex-1 bg-gray-200 rounded-full h-3">
                      <div 
                        className={`h-3 rounded-full transition-all ${scheme.progress}`}
                        style={{ width: `${parsedAnalysis.prompt_quality_score * 10}%` }}
                      />
                    </div>
                  </div>
                  {parsedAnalysis.prompt_improvements && (
                    <div className="mt-3">
                      <p className="text-sm font-medium text-gray-700 mb-1">Suggested Improvements:</p>
                      <p className="text-gray-700 text-sm">{parsedAnalysis.prompt_improvements}</p>
                    </div>
                  )}
                </div>
              )}

              {parsedAnalysis.recommendations && parsedAnalysis.recommendations.length > 0 && (
                <div className={`bg-white rounded-lg p-4 border ${scheme.cardBorder}`}>
                  <h5 className={`font-semibold mb-3 ${scheme.heading}`}>Recommendations</h5>
                  <ul className="space-y-2">
                    {parsedAnalysis.recommendations.map((rec, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                        <span className={`mt-0.5 ${scheme.bullet}`}>•</span>
                        <span>{rec}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-gray-700">
              <pre className="whitespace-pre-wrap font-mono">{JSON.stringify(parsedAnalysis, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
      {!parsedAnalysis && !loading && (
        <div className={`p-4 rounded-lg border ${scheme.bg} ${scheme.border}`}>
          <div className="text-gray-500 text-sm">{emptyStateText}</div>
        </div>
      )}
    </div>
  );
};

export default DeepDiveAnalysis;
