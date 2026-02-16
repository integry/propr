// Utility functions for header components
// Separated to allow React Fast Refresh to work properly

// Status badge colors based on plan status - using outline pill style
export const getStatusBadgeStyle = (status: string): string => {
  switch (status) {
    case 'generating':
    case 'refining':
      return 'border border-blue-200 text-blue-600 bg-transparent';
    case 'review':
      return 'border border-amber-200 text-amber-600 bg-transparent';
    case 'approved':
      return 'border border-green-200 text-green-600 bg-transparent';
    case 'executing':
      return 'border border-purple-200 text-purple-600 bg-transparent';
    case 'draft':
    default:
      return 'border border-gray-200 text-gray-600 bg-transparent';
  }
};

// Format date to relative time
export const formatRelativeTime = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};
