import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { goalPreviewSource, previewMediaReader, taskPreviewSource } from '../services/previewMediaProjection.js';
import { repositoryScopeOrRespond, resolveRepositoryScope, type RepositoryScopeResolver } from '../repositoryScope.js';

const PAGE_SIZE = 24;

export function createRepositoryMediaRoutes(deps: { db: Knex; reader?: typeof previewMediaReader; repositoryScope?: RepositoryScopeResolver }) {
  const reader = deps.reader ?? previewMediaReader;
  const repositoryScope = deps.repositoryScope ?? resolveRepositoryScope;
  return {
    async getMedia(req: Request, res: Response): Promise<void> {
      if (!req.user?.id) { res.status(401).json({ error: 'Authentication required' }); return; }
      const repository = typeof req.query.repository === 'string' ? req.query.repository.trim().toLowerCase() : '';
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')
        || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
        res.status(400).json({ error: 'A repository and valid media offset are required' }); return;
      }
      // A repository this instance does not configure, or the caller cannot read, is not accessible.
      // The resolved configured spelling is what the reads and projections use;
      // stored rows are matched by its lowercase form, as the preview policy keys are.
      const canonical = await repositoryScopeOrRespond(req, res, repository, { resolver: repositoryScope, allowAll: false, context: '/api/repos/media' });
      if (canonical === null) return;
      const repositoryKey = canonical.toLowerCase();
      try {
        if (!(await reader.enabledRepositories([canonical])).has(repositoryKey)) {
          res.json({ previews: [], nextOffset: null }); return;
        }
        const [tasks, goals] = await Promise.all([
          deps.db('tasks').whereRaw('LOWER(repository) = ?', [repositoryKey])
            .where(function () { this.whereNull('task_type').orWhereNot('task_type', 'goal'); })
            .orderBy('created_at', 'desc').orderBy('task_id', 'desc').limit(PAGE_SIZE + 1).offset(offset)
            .select('repository', 'pr_number', 'initial_job_data', 'final_result'),
          deps.db('goals').whereRaw('LOWER(repository) = ?', [repositoryKey]).where('owner_id', String(req.user.id))
            .orderBy('created_at', 'desc').orderBy('goal_id', 'desc').limit(PAGE_SIZE + 1).offset(offset)
            .select('repository', 'final_pr_number', 'artifact_refs'),
        ]);
        const sources = [...tasks.slice(0, PAGE_SIZE).map(taskPreviewSource), ...goals.slice(0, PAGE_SIZE).map(goalPreviewSource)]
          .map(source => ({ ...source, repository: canonical }));
        const media = await reader.project(sources.flatMap(source => source.prNumbers.map(number => ({ repository: source.repository, prNumbers: [number] }))), 8, 'gallery');
        const previews = [...new Map(media.flatMap(item => item.previews).map(preview => [preview.url, preview])).values()];
        res.json({ previews, nextOffset: tasks.length > PAGE_SIZE || goals.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
          ...(media.some(item => item.unavailable) ? { unavailable: true } : {}) });
      } catch {
        res.status(503).json({ error: 'Repository media is unavailable. Please try again.' });
      }
    },
  };
}
