export interface DetailedAnalysisData {
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

export const parseAnalysis = (analysis: DetailedAnalysisData | string | null | unknown): DetailedAnalysisData | null => {
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
