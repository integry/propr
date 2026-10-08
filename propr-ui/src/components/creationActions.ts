import { ScrollText, Target, Workflow, Zap } from 'lucide-react';
import { matchPath } from 'react-router-dom';

const creationActions = [
  { id: 'task', label: 'New Task', to: '/tasks/new', icon: Zap },
  { id: 'plan', label: 'New Plan', to: '/studio/new', icon: ScrollText },
  { id: 'goal', label: 'New Goal', to: '/goals?new=1', icon: Target },
  { id: 'automation', label: 'New Automation', to: '/automations/new', icon: Workflow },
] as const;

// Match whole route segments, including detail pages, using router semantics.
// Add future sections here; unmatched pages keep task creation as the default.
const routeActions = [
  { path: '/plans/*', action: 'plan' },
  { path: '/studio/*', action: 'plan' },
  { path: '/goals/*', action: 'goal' },
  { path: '/automations/*', action: 'automation' },
] as const;

export function getCreationActions(pathname: string) {
  const primaryId = routeActions.find(route => matchPath(route.path, pathname))?.action ?? 'task';
  return {
    primary: creationActions.find(action => action.id === primaryId)!,
    secondary: creationActions.filter(action => action.id !== primaryId),
  };
}
