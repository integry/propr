import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, CheckCircle, Github, ChevronDown, GitMerge, FileQuestion } from 'lucide-react';
import { DraftWithPlan } from '../../api/gitfixApi';
import PlanIssuesManager from './PlanIssuesManager';

interface ApprovedPlanViewProps {
  draft: DraftWithPlan;
}

// Original Prompt Section Component
interface OriginalPromptSectionProps {
  prompt: string;
}

const OriginalPromptSection: React.FC<OriginalPromptSectionProps> = ({ prompt }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border-b border-gray-200 bg-slate-50">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-100 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <FileQuestion size={14} />
          <span className="font-medium">Original Prompt</span>
        </div>
        <motion.div
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronDown size={16} className="text-slate-400" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 pt-1">
              <div className="bg-white rounded-lg border border-slate-200 p-3">
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{prompt}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};


export const ApprovedPlanView: React.FC<ApprovedPlanViewProps> = ({ draft }) => {
  // Defensively ensure plan_json is an array
  const tasks = (() => {
    let planJson = draft.plan_json;
    if (typeof planJson === 'string') {
      try { planJson = JSON.parse(planJson); } catch { return []; }
    }
    return Array.isArray(planJson) ? planJson : [];
  })();

  // Extract repository URL from draft
  const getRepositoryUrl = () => {
    const repo = draft.repository;
    if (!repo) return null;
    return `https://github.com/${repo}/issues`;
  };

  const repoUrl = getRepositoryUrl();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full bg-white overflow-hidden flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-500 truncate max-w-md">{draft.task_title || draft.title || 'Untitled Task'}</div>
          {draft.status === 'merged' ? (
            <span className="px-2 py-1 rounded text-xs font-medium bg-purple-100 text-purple-700 flex items-center gap-1">
              <GitMerge size={12} />
              Merged
            </span>
          ) : (
            <span className="px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-700 flex items-center gap-1">
              <CheckCircle size={12} />
              Issues created
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors text-sm"
            >
              <Github size={16} />
              View on GitHub
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>

      {/* Original Prompt Section */}
      {draft.initial_prompt && (
        <OriginalPromptSection prompt={draft.initial_prompt} />
      )}

      {/* Single-Pane Action Dashboard */}
      <div className="flex-1 overflow-auto p-4">
        <PlanIssuesManager
          draftId={draft.draft_id}
          tasks={tasks}
          repository={draft.repository}
        />
      </div>
    </motion.div>
  );
};

export default ApprovedPlanView;
