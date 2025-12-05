export const WORKSPACE_PREFIXES = [
  '/home/node/workspace/',
  /\/tmp\/git-processor\/worktrees\/[^\/]+\/[^\/]+\/[^\/]+\//
];

export const formatDisplayPath = (fullPath: string): string => {
  if (!fullPath || typeof fullPath !== 'string') {
    return fullPath;
  }
  
  for (const prefix of WORKSPACE_PREFIXES) {
    if (typeof prefix === 'string' && fullPath.startsWith(prefix)) {
      return fullPath.substring(prefix.length);
    } else if (prefix instanceof RegExp) {
      const match = fullPath.match(prefix);
      if (match) {
        return fullPath.substring(match[0].length);
      }
    }
  }
  
  return fullPath;
};

export const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleString();
};

export const formatModelName = (modelId: string | undefined): string => {
  if (!modelId) return 'Unknown Model';
  const modelMap: Record<string, string> = {
    'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
    'claude-sonnet-3-5-20240620': 'Claude Sonnet 3.5',
    'claude-opus-3-20240229': 'Claude Opus 3',
    'claude-haiku-3-20240307': 'Claude Haiku 3',
  };
  return modelMap[modelId] || modelId;
};

export const formatRelativeTime = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

export const getStatusIcon = (status: string): string => {
  if (status === 'COMPLETED') return '✅';
  if (status === 'FAILED') return '❌';
  if (['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(status)) return '⏳';
  return '📋';
};

export const stripWorkspacePrefixes = (text: string): string => {
  let result = text;
  for (const prefix of WORKSPACE_PREFIXES) {
    if (typeof prefix === 'string') {
      result = result.split(prefix).join('');
    } else if (prefix instanceof RegExp) {
      result = result.replace(new RegExp(prefix.source, 'g'), '');
    }
  }
  return result;
};
