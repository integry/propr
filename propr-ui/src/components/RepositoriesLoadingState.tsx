import React from 'react';
import { ListSkeleton } from './ui/Skeleton';

/** The repository list's first read: rows shaped like the list that lands in their place. */
export const RepositoriesLoadingState: React.FC = () => (
  <ListSkeleton rows={6} layout="row" label="Loading repositories…" className="px-4 py-3" data-testid="repositories-skeleton" />
);
