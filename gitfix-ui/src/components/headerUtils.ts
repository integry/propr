// Utility functions for header components
// Separated to allow React Fast Refresh to work properly

// Status badge colors based on plan status
export const getStatusBadgeStyle = (status: string): string => {
  switch (status) {
    case 'generating':
    case 'refining':
      return 'bg-blue-100 text-blue-700';
    case 'review':
      return 'bg-amber-100 text-amber-700';
    case 'approved':
      return 'bg-green-100 text-green-700';
    case 'executing':
      return 'bg-purple-100 text-purple-700';
    case 'draft':
    default:
      return 'bg-gray-100 text-gray-700';
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
