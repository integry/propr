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
  onRunAnalysis: () => void;
  renderMarkdown?: (text: string) => React.ReactNode;
}

const DeepDiveAnalysis: React.FC<DeepDiveAnalysisProps> = ({
  analysis,
  loading,
  onRunAnalysis,
  renderMarkdown = (text) => text,
}) => {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-lg font-semibold text-gray-900">Deep-Dive Analysis (Advanced Model)</h4>
        <button
          onClick={onRunAnalysis}
          disabled={loading}
          className="px-3 py-1.5 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {loading ? 'Analyzing...' : 'Run Deep-Dive Analysis'}
        </button>
      </div>
      {loading && (
        <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
          <div className="text-purple-800">Running deep-dive analysis with advanced model...</div>
        </div>
      )}
      {analysis && !loading && (
        <div className="space-y-4 p-4 bg-purple-50 rounded-lg border border-purple-200">
          {typeof analysis === 'object' && 'error' in analysis && analysis.error ? (
            <div className="text-red-600">{analysis.error}</div>
          ) : typeof analysis === 'string' ? (
            renderMarkdown(analysis)
          ) : (
            <div className="space-y-4">
              {analysis.efficiency_score !== undefined && (
                <div className="bg-white rounded-lg p-4 border border-purple-300">
                  <h5 className="font-semibold text-purple-900 mb-2">Efficiency Score</h5>
                  <div className="flex items-center gap-3">
                    <div className="text-3xl font-bold text-purple-700">
                      {analysis.efficiency_score}/10
                    </div>
                    <div className="flex-1 bg-gray-200 rounded-full h-3">
                      <div 
                        className="bg-purple-600 h-3 rounded-full transition-all"
                        style={{ width: `${analysis.efficiency_score * 10}%` }}
                      />
                    </div>
                  </div>
                  {analysis.efficiency_notes && (
                    <p className="text-gray-700 mt-3 text-sm">{analysis.efficiency_notes}</p>
                  )}
                </div>
              )}

              {analysis.tool_usage_summary && (
                <div className="bg-white rounded-lg p-4 border border-purple-300">
                  <h5 className="font-semibold text-purple-900 mb-3">Tool Usage Summary</h5>
                  {analysis.tool_usage_summary.most_used_tools && (
                    <div className="mb-3">
                      <p className="text-sm font-medium text-gray-700 mb-2">Most Used Tools:</p>
                      <div className="flex flex-wrap gap-2">
                        {analysis.tool_usage_summary.most_used_tools.map((tool, idx) => (
                          <span key={idx} className="bg-purple-100 text-purple-800 px-3 py-1 rounded-full text-sm font-medium">
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {analysis.tool_usage_summary.tool_appropriateness && (
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-1">Tool Appropriateness:</p>
                      <p className="text-gray-700 text-sm">{analysis.tool_usage_summary.tool_appropriateness}</p>
                    </div>
                  )}
                </div>
              )}

              {analysis.error_analysis && (
                <div className="bg-white rounded-lg p-4 border border-purple-300">
                  <h5 className="font-semibold text-purple-900 mb-2">Error Analysis</h5>
                  <p className="text-gray-700 text-sm">{analysis.error_analysis}</p>
                </div>
              )}

              {analysis.prompt_quality_score !== undefined && (
                <div className="bg-white rounded-lg p-4 border border-purple-300">
                  <h5 className="font-semibold text-purple-900 mb-2">Prompt Quality Score</h5>
                  <div className="flex items-center gap-3">
                    <div className="text-3xl font-bold text-purple-700">
                      {analysis.prompt_quality_score}/10
                    </div>
                    <div className="flex-1 bg-gray-200 rounded-full h-3">
                      <div 
                        className="bg-purple-600 h-3 rounded-full transition-all"
                        style={{ width: `${analysis.prompt_quality_score * 10}%` }}
                      />
                    </div>
                  </div>
                  {analysis.prompt_improvements && (
                    <div className="mt-3">
                      <p className="text-sm font-medium text-gray-700 mb-1">Suggested Improvements:</p>
                      <p className="text-gray-700 text-sm">{analysis.prompt_improvements}</p>
                    </div>
                  )}
                </div>
              )}

              {analysis.recommendations && analysis.recommendations.length > 0 && (
                <div className="bg-white rounded-lg p-4 border border-purple-300">
                  <h5 className="font-semibold text-purple-900 mb-3">Recommendations</h5>
                  <ul className="space-y-2">
                    {analysis.recommendations.map((rec, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                        <span className="text-purple-600 mt-0.5">•</span>
                        <span>{rec}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {!analysis && !loading && (
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="text-gray-500 text-sm">Click "Run Deep-Dive Analysis" to generate an in-depth analysis using the advanced model.</div>
        </div>
      )}
    </div>
  );
};

export default DeepDiveAnalysis;
