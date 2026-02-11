import React, { useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, CheckCircle, MessageSquare, StickyNote, Github, ChevronDown, GitMerge, FileQuestion, GripVertical, Clock, AlertCircle, Loader2, Play } from 'lucide-react';
import { DraftWithPlan, PlanTask } from '../../api/gitfixApi';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';
import PlanIssuesManager from './PlanIssuesManager';

interface ApprovedPlanViewProps {
  draft: DraftWithPlan;
}

interface ViewOnlyTaskCardProps {
  task: PlanTask;
  index: number;
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

// Issue Card Component for left panel
interface IssueCardProps {
  task: PlanTask;
  index: number;
}

const IssueCard: React.FC<IssueCardProps> = ({ task, index }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Determine status based on task data
  const getStatus = () => {
    if (task.issue_url) {
      return 'created';
    }
    return 'pending';
  };

  const status = getStatus();

  const statusConfig = {
    pending: { bg: 'bg-gray-100', text: 'text-gray-600', icon: Clock, label: 'Pending' },
    in_progress: { bg: 'bg-blue-100', text: 'text-blue-600', icon: Loader2, label: 'In Progress' },
    created: { bg: 'bg-green-100', text: 'text-green-600', icon: CheckCircle, label: 'Created' },
    failed: { bg: 'bg-red-100', text: 'text-red-600', icon: AlertCircle, label: 'Failed' }
  };

  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending;
  const StatusIcon = config.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.05 }}
      className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow"
    >
      {/* Card Header */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className={`mt-0.5 p-1.5 ${config.bg} ${config.text} rounded-md flex-shrink-0`}>
              <StatusIcon size={16} className={status === 'in_progress' ? 'animate-spin' : ''} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-gray-900 text-sm truncate">
                  {task.title}
                </h3>
                {task.issue_url && (
                  <a
                    href={task.issue_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors flex-shrink-0"
                  >
                    <Github size={10} />
                    #{task.issue_number}
                    <ExternalLink size={8} />
                  </a>
                )}
              </div>
              <span className={`inline-flex items-center gap-1 text-xs ${config.text} mt-1`}>
                {config.label}
              </span>
            </div>
          </div>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors flex-shrink-0"
          >
            <motion.div
              animate={{ rotate: isExpanded ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown size={16} />
            </motion.div>
          </button>
        </div>
      </div>

      {/* Expandable Content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-0 border-t border-gray-100">
              {/* Context */}
              {task.body && (
                <div className="mt-3">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Context</span>
                  <div className="mt-1 text-sm text-gray-600">
                    <MarkdownRenderer text={task.body} className="prose prose-sm max-w-none" />
                  </div>
                </div>
              )}

              {/* Implementation */}
              {task.implementation && (
                <div className="mt-3 bg-slate-50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <MessageSquare size={12} className="text-slate-500" />
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Implementation</span>
                  </div>
                  <div className="text-sm text-slate-700">
                    <MarkdownRenderer text={task.implementation} className="prose prose-sm max-w-none" />
                  </div>
                </div>
              )}

              {/* Notes */}
              {task.notes && (
                <div className="mt-3 bg-white rounded-lg p-3 border border-dashed border-gray-300">
                  <div className="flex items-center gap-2 mb-2">
                    <StickyNote size={12} className="text-slate-500" />
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Notes</span>
                  </div>
                  <div className="text-sm text-gray-600">
                    <MarkdownRenderer text={task.notes} className="prose prose-sm max-w-none" />
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

// Execution Status Panel Component
interface ExecutionStatusPanelProps {
  draft: DraftWithPlan;
  tasks: PlanTask[];
}

const ExecutionStatusPanel: React.FC<ExecutionStatusPanelProps> = ({ draft, tasks }) => {
  const createdCount = tasks.filter(t => t.issue_url).length;
  const totalCount = tasks.length;

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Panel Header */}
      <div className="px-4 py-3 border-b border-gray-200 bg-white">
        <h3 className="font-semibold text-gray-900 text-sm">Execution Status</h3>
        <p className="text-xs text-gray-500 mt-0.5">Monitor your plan execution</p>
      </div>

      {/* Status Summary */}
      <div className="p-4 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-gray-600">Progress</span>
          <span className="text-sm font-medium text-gray-900">{createdCount} / {totalCount}</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-green-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${(createdCount / totalCount) * 100}%` }}
          />
        </div>
      </div>

      {/* Status Messages / Log */}
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-3">
          {/* Success Message */}
          <div className="flex items-start gap-3 p-3 bg-green-50 rounded-lg border border-green-200">
            <CheckCircle size={16} className="text-green-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-green-800">Issues Created Successfully</p>
              <p className="text-xs text-green-600 mt-0.5">
                {createdCount} GitHub {createdCount === 1 ? 'issue has' : 'issues have'} been created from your plan
              </p>
            </div>
          </div>

          {/* Repository Info */}
          <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-gray-200">
            <Github size={16} className="text-gray-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Repository</p>
              <a
                href={`https://github.com/${draft.repository}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1 mt-0.5"
              >
                {draft.repository}
                <ExternalLink size={10} />
              </a>
            </div>
          </div>

          {/* Status Badge */}
          <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-gray-200">
            {draft.status === 'merged' ? (
              <>
                <GitMerge size={16} className="text-purple-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-gray-800">Status: Merged</p>
                  <p className="text-xs text-gray-500 mt-0.5">All issues have been merged</p>
                </div>
              </>
            ) : (
              <>
                <Play size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-gray-800">Status: Ready for Implementation</p>
                  <p className="text-xs text-gray-500 mt-0.5">Issues are ready for agents to implement</p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div className="p-4 border-t border-gray-200 bg-white">
        <a
          href={`https://github.com/${draft.repository}/issues`}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors text-sm font-medium"
        >
          <Github size={16} />
          View All Issues on GitHub
          <ExternalLink size={14} />
        </a>
      </div>
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

      {/* Split View Content */}
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* Left Panel - Issue Cards */}
          <Panel defaultSize={60} minSize={40}>
            <div className="h-full flex flex-col">
              {/* Issue List Header */}
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-700 text-sm">
                    Plan Issues ({tasks.length})
                  </h3>
                  <span className="text-xs text-gray-500">
                    {tasks.filter(t => t.issue_url).length} created
                  </span>
                </div>
              </div>

              {/* Issue Cards */}
              <div className="flex-1 overflow-auto p-4 space-y-3">
                {tasks.map((task, index) => (
                  <IssueCard key={task.id} task={task} index={index} />
                ))}
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="w-2 bg-gray-200 hover:bg-indigo-400 transition-colors flex items-center justify-center cursor-col-resize">
            <GripVertical size={12} className="text-gray-400" />
          </PanelResizeHandle>

          {/* Right Panel - Execution Status / Management */}
          <Panel defaultSize={40} minSize={25}>
            <div className="h-full overflow-hidden">
              <PlanIssuesManager
                draftId={draft.draft_id}
                tasks={tasks}
                repository={draft.repository}
              />
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </motion.div>
  );
};

export default ApprovedPlanView;
