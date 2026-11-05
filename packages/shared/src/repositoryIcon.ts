import { createElement as h, useMemo, useState } from 'react';
import { Github } from 'lucide-react';
import { buildRepositoryIconUrl } from './repositoryIconUrl.js';

interface RepositoryIconProps {
  repository: string;
  iconPath?: string | null;
  revision?: string | null;
  className?: string;
  fallbackClassName?: string;
  /** Dense lists may omit the fallback to let the repository slug stand alone. */
  fallback?: 'github' | 'none';
}

export function RepositoryIconFallback({ className = '' }: { className?: string }) {
  const props = { 'data-testid': 'repository-icon-fallback', className, 'aria-hidden': true as const };
  return h(Github, props);
}

export function RepositoryIcon({ repository, iconPath, revision, className = 'w-4 h-4', fallbackClassName = 'text-gray-400', fallback = 'github' }: RepositoryIconProps) {
  const imageUrl = useMemo(() => iconPath ? buildRepositoryIconUrl(repository, iconPath, revision || 'HEAD') : null, [repository, iconPath, revision]);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (imageUrl && failedUrl !== imageUrl) return h('img', {
    src: imageUrl, alt: '', 'data-testid': 'repository-icon-image',
    className: `${className} rounded flex-shrink-0 object-contain`,
    onError: () => setFailedUrl(imageUrl),
  });
  if (fallback === 'none') return null;
  return h(RepositoryIconFallback, { className: `${className} ${fallbackClassName} flex-shrink-0` });
}
