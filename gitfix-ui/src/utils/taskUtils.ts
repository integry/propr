export interface Task {
  id: string;
  repository?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  issueNumber?: number;
  title?: string;
  subtitle?: string;
  status: string;
  createdAt: string;
  processedAt?: string;
  completedAt?: string;
  modelName?: string;
  model?: string;
  llmProvider?: string;
}

export interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  issueNumber?: number;
  tasks: Task[];
}

export const getStatusPillClasses = (status: string): string => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700';
    case 'failed':
      return 'bg-red-100 text-red-700';
    case 'active':
    case 'claude_execution':
    case 'processing':
      return 'bg-blue-100 text-blue-700';
    case 'waiting':
    case 'pending':
      return 'bg-purple-100 text-purple-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
};

export const isActiveStatus = (status: string): boolean => {
  return ['active', 'claude_execution', 'processing'].includes(status);
};

export const getStatusLabel = (status: string): string => {
  switch (status) {
    case 'claude_execution':
      return 'Implementing';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'active':
    case 'processing':
      return 'Processing';
    case 'waiting':
    case 'pending':
      return 'Pending';
    default:
      return status;
  }
};

export const formatRelativeTime = (dateString: string | undefined): string => {
  if (!dateString) return 'N/A';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return date.toLocaleDateString();
  }
};

export const formatDuration = (startTime: string | undefined, endTime: string | undefined, status: string): string => {
  if (!startTime) return 'N/A';

  const end = endTime ? new Date(endTime) : new Date();
  const duration = end.getTime() - new Date(startTime).getTime();

  const minutes = Math.floor(duration / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);

  const isActive = ['active', 'claude_execution', 'processing'].includes(status);
  const suffix = isActive ? ' (running)' : '';
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s${suffix}`;
};

export const getTaskIdentifier = (task: Task): string => {
  if (task.id.startsWith('pr-comments-batch')) {
    return `PR #${task.issueNumber || 'N/A'}`;
  }
  return task.issueNumber ? `#${task.issueNumber}` : 'Task';
};

export const groupTasks = (tasks: Task[]): TaskGroup[] => {
  const groups: Record<string, TaskGroup> = {};

  tasks.forEach(task => {
    const [owner, name] = (task.repository || 'unknown/unknown').split('/');
    const key = task.issueNumber
      ? `${task.repository}-${task.issueNumber}`
      : task.id;

    if (!groups[key]) {
      groups[key] = {
        key,
        repoOwner: owner,
        repoName: name || owner,
        issueNumber: task.issueNumber,
        tasks: []
      };
    }
    groups[key].tasks.push(task);
  });

  // Sort tasks within each group by createdAt (newest first)
  Object.values(groups).forEach(group => {
    group.tasks.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });

  // Sort groups by the date of their most recent task
  return Object.values(groups).sort((a, b) => {
    return new Date(b.tasks[0].createdAt).getTime() - new Date(a.tasks[0].createdAt).getTime();
  });
};
