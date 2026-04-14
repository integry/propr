import { getPlannerSettings } from '../../hooks/usePlannerSettings';
import { Repo } from './NewPlanForm';

// Helper function to transform raw repository data into Repo objects
export const transformRepoData = (rawRepos: unknown[]): Repo[] => {
  const seen = new Set<string>();
  return rawRepos
    .map((repo: unknown) => {
      if (typeof repo === 'string') {
        return { name: repo, enabled: true };
      }
      if (repo && typeof repo === 'object') {
        const repoObj = repo as Record<string, unknown>;
        const name = (repoObj.name as string) || (repoObj.full_name as string);
        const enabled = typeof repoObj.enabled === 'boolean' ? repoObj.enabled : true;
        const baseBranch = repoObj.baseBranch as string | undefined;
        if (name) {
          return { name, enabled, baseBranch };
        }
      }
      return null;
    })
    .filter((repo): repo is Repo => {
      if (repo === null || repo.name === undefined) return false;
      if (seen.has(repo.name)) return false;
      seen.add(repo.name);
      return true;
    });
};

// Helper function to determine initial selected repository
export const getInitialSelectedRepo = (enabledRepos: Repo[]): string => {
  if (enabledRepos.length === 0) return '';

  const savedSettings = getPlannerSettings();
  const lastRepo = savedSettings.lastRepository;
  const isLastRepoAvailable = lastRepo && enabledRepos.some(r => r.name === lastRepo);

  return isLastRepoAvailable ? lastRepo : enabledRepos[0].name;
};
