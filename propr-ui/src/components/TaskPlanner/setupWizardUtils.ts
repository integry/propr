import { Granularity } from '../../api/proprApi';

export const getEstimatedIssueText = (granularity: Granularity): string => {
  const counts: Record<Granularity, string> = { single: '1', balanced: '3-5', granular: '7-15+' };
  const count = counts[granularity] || '1';
  return `${count} ${count === '1' ? 'issue' : 'issues'}`;
};
