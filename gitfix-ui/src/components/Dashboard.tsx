import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import TaskStatsChart from './TaskStatsChart';
import RepositoryBreakdown from './RepositoryBreakdown';
import TaskList from './TaskList';
import { getRepoConfig, createDraft, uploadAttachment, getQueueStats } from '../api/gitfixApi';
import { getTaskStats, TaskStatsResponse } from '../api/taskStatsApi';
import { resizeImage } from './TaskPlanner/imageUtils';
import { NewPlanForm, KPICard, transformRepoData, getInitialSelectedRepo, Repo } from './Dashboard/index';

interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
}

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [prompt, setPrompt] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isPastingImage, setIsPastingImage] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lifted state for KPIs
  const [taskStats, setTaskStats] = useState<TaskStatsResponse | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(true);

  useEffect(() => {
    const loadRepos = async () => {
      try {
        const data = await getRepoConfig() as { repos_to_monitor?: unknown[] };
        const rawRepos = data.repos_to_monitor || [];
        const validRepos = transformRepoData(rawRepos);
        const enabledRepos = validRepos.filter((r: Repo) => r.enabled);
        setRepos(enabledRepos);
        setSelectedRepo(getInitialSelectedRepo(enabledRepos));
      } catch (err) {
        console.error('Failed to load repositories:', err);
      }
    };
    loadRepos();
  }, []);

  // Fetch task stats and queue stats for KPIs
  useEffect(() => {
    const fetchAllStats = async () => {
      try {
        setStatsLoading(true);
        const [tStats, qStats] = await Promise.all([
          getTaskStats(),
          getQueueStats()
        ]);
        setTaskStats(tStats);
        setQueueStats(qStats as QueueStats);
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      } finally {
        setStatsLoading(false);
      }
    };

    fetchAllStats();
    const interval = setInterval(fetchAllStats, 5000);
    return () => clearInterval(interval);
  }, []);

  // Calculate success rate
  const getSuccessRate = (): string => {
    if (!taskStats?.summary) return '0%';
    const { completed, total } = taskStats.summary;
    if (total === 0) return '0%';
    return Math.round((completed / total) * 100) + '%';
  };

  const handleStartPlanning = async () => {
    if (!selectedRepo || !prompt.trim()) return;

    setIsCreating(true);
    setError(null);
    try {
      const draft = await createDraft(selectedRepo, prompt.trim());

      // Upload any selected files to the draft
      for (const file of selectedFiles) {
        try {
          await uploadAttachment(draft.draft_id, file);
        } catch (uploadErr) {
          console.error('Failed to upload attachment:', uploadErr);
        }
      }

      navigate(`/tasks/plan/${draft.draft_id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
    } finally {
      setIsCreating(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFiles(prev => [...prev, ...Array.from(files)]);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;

        const filename = `pasted-image-${Date.now()}.png`;
        const file = new File([blob], filename, { type: blob.type });

        setIsPastingImage(true);
        setError(null);
        try {
          const processedFile = await resizeImage(file);
          setSelectedFiles(prev => [...prev, processedFile]);
        } catch (err) {
          setError('Failed to process pasted image');
          console.error('Paste error:', err);
        } finally {
          setIsPastingImage(false);
        }
        return;
      }
    }
  };

  return (
    <div>
      <NewPlanForm
        repos={repos}
        selectedRepo={selectedRepo}
        onRepoChange={setSelectedRepo}
        prompt={prompt}
        onPromptChange={setPrompt}
        onPaste={handlePaste}
        selectedFiles={selectedFiles}
        onRemoveFile={handleRemoveFile}
        onFileSelect={handleFileSelect}
        fileInputRef={fileInputRef}
        isPastingImage={isPastingImage}
        error={error}
        isCreating={isCreating}
        onStartPlanning={handleStartPlanning}
      />

      {/* KPI Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <KPICard
          title="Active Tasks"
          value={queueStats?.active || 0}
          color="text-green-600"
          isLoading={statsLoading && !queueStats}
        />
        <KPICard
          title="Success Rate"
          value={getSuccessRate()}
          color="text-blue-600"
          isLoading={statsLoading && !taskStats}
        />
        <KPICard
          title="Total Tasks"
          value={taskStats?.summary?.total || 0}
          isLoading={statsLoading && !taskStats}
        />
        <KPICard
          title="Failed"
          value={taskStats?.summary?.failed || 0}
          color="text-red-500"
          isLoading={statsLoading && !taskStats}
        />
      </div>

      {/* Main Grid - 2 columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2/3 width) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Trend Charts */}
          <TaskStatsChart data={taskStats} mode="trends" />

          {/* Recent Tasks */}
          <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 mb-4">Recent Tasks</h3>
            <TaskList
              limit={5}
              showViewAll={true}
              hideFilters={true}
            />
          </div>
        </div>

        {/* Right Column (1/3 width) */}
        <div className="space-y-6">
          {/* Status Distribution */}
          <TaskStatsChart data={taskStats} mode="distribution" />

          {/* Top Repositories */}
          <RepositoryBreakdown limit={5} />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
