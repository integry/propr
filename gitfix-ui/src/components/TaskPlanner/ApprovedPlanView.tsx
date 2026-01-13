import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, CheckCircle, MessageSquare, StickyNote, Github, ChevronDown } from 'lucide-react';
import { DraftWithPlan, PlanTask } from '../../api/gitfixApi';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';

interface ApprovedPlanViewProps {
  draft: DraftWithPlan;
}

interface ViewOnlyTaskCardProps {
  task: PlanTask;
  index: number;
}

const ViewOnlyTaskCard: React.FC<ViewOnlyTaskCardProps> = ({ task, index }) => {
  const [isImplementationCollapsed, setIsImplementationCollapsed] = useState(true);

  const toggleImplementationCollapse = () => {
    setIsImplementationCollapsed(prev => !prev);
  };

  const getImplementationPreview = () => {
    if (!task.implementation) return 'No implementation details';
    const firstLine = task.implementation.split('\n')[0];
    return firstLine.length > 80 ? firstLine.substring(0, 80) + '...' : firstLine || 'Click to expand';
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="group relative"
    >
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden ml-8 shadow-sm">
        {/* SECTION 1: ISSUE HEADER (Title & Context) */}
        <div className="p-6 pb-4">
          <div className="flex items-start gap-3 mb-4">
            <div className="mt-1 p-1.5 bg-green-50 text-green-600 rounded-md">
              <CheckCircle size={18} />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="text-lg font-bold text-gray-900">
                  {task.title}
                </h3>
                {task.issue_url && (
                  <a
                    href={task.issue_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors"
                  >
                    <Github size={12} />
                    #{task.issue_number}
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
              <div className="mt-2">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Context</span>
                {task.body ? (
                  <div className="mt-1 text-gray-600 leading-relaxed">
                    <MarkdownRenderer text={task.body} className="prose prose-sm max-w-none" />
                  </div>
                ) : (
                  <p className="mt-1 text-gray-400 italic text-sm">No context provided</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 2: IMPLEMENTATION (Comment Style) */}
        <div className="bg-slate-50 border-t border-gray-100 p-6 pt-4">
          <div className="flex items-start gap-3">
            <div
              className="mt-1 p-1.5 bg-slate-200 text-slate-600 rounded-md cursor-pointer hover:bg-slate-300 transition-colors"
              onClick={toggleImplementationCollapse}
            >
              <MessageSquare size={16} />
            </div>
            <div className="flex-1">
              <div
                className="flex items-center justify-between mb-2 cursor-pointer select-none"
                onClick={toggleImplementationCollapse}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Suggested Implementation</span>
                  <motion.div
                    animate={{ rotate: isImplementationCollapsed ? 0 : 180 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ChevronDown size={16} className="text-slate-400" />
                  </motion.div>
                </div>
              </div>

              <AnimatePresence initial={false}>
                {isImplementationCollapsed ? (
                  <motion.div
                    key="collapsed"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="text-sm text-slate-400 italic truncate cursor-pointer"
                    onClick={toggleImplementationCollapse}
                  >
                    {getImplementationPreview()}
                  </motion.div>
                ) : (
                  <motion.div
                    key="expanded"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    {task.implementation ? (
                      <div className="font-mono text-sm text-slate-700">
                        <MarkdownRenderer text={task.implementation} className="prose prose-sm max-w-none" />
                      </div>
                    ) : (
                      <p className="text-slate-400 italic text-sm">No implementation details</p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* SECTION 3: NOTES (Draft Style) */}
        {task.notes && (
          <div className="bg-yellow-50/50 border-t border-yellow-100/50 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-1 p-1.5 text-yellow-600">
                <StickyNote size={16} />
              </div>
              <div className="flex-1">
                <span className="text-xs font-semibold text-yellow-600/70 uppercase tracking-wider block mb-1">User Notes</span>
                <div className="text-sm text-gray-600">
                  <MarkdownRenderer text={task.notes} className="prose prose-sm max-w-none" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </motion.div>
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
    // Format: "owner/repo"
    const repo = draft.repository;
    if (!repo) return null;
    return `https://github.com/${repo}/issues`;
  };

  const repoUrl = getRepositoryUrl();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full bg-white rounded-lg shadow overflow-hidden flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-500 truncate max-w-md">{(draft as DraftWithPlan & { name?: string }).name || 'Untitled Task'}</div>
          <span className="px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-700 flex items-center gap-1">
            <CheckCircle size={12} />
            Approved
          </span>
        </div>

        <div className="flex items-center gap-2">
          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
            >
              <Github size={16} />
              View on GitHub
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>

      {/* Success Banner */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-green-50 border-b border-green-200 px-4 py-3"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-green-100 rounded-full">
            <CheckCircle size={18} className="text-green-600" />
          </div>
          <div>
            <p className="text-green-800 font-medium">
              {tasks.length} GitHub {tasks.length === 1 ? 'issue' : 'issues'} created successfully
            </p>
            <p className="text-green-600 text-sm">
              Your implementation plan has been converted to GitHub issues
            </p>
          </div>
        </div>
      </motion.div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex">
          {/* Timeline */}
          <div className="w-16 flex-shrink-0 py-2">
            <div className="flex flex-col items-center">
              {tasks.map((_, index) => (
                <div key={index} className="flex flex-col items-center">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.3 + index * 0.1, type: "spring", stiffness: 500 }}
                    className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center"
                  >
                    <CheckCircle size={16} className="text-green-600" />
                  </motion.div>
                  {index < tasks.length - 1 && (
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: 40 }}
                      transition={{ delay: 0.4 + index * 0.1 }}
                      className="w-0.5 bg-green-200"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Cards */}
          <div className="flex-1 space-y-4">
            {tasks.map((task, index) => (
              <ViewOnlyTaskCard key={task.id} task={task} index={index} />
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default ApprovedPlanView;
