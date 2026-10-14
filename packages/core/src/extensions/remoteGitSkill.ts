import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/core';
import { EXTENSION_LIMITS } from '@propr/shared';
import type { ExtensionProfileStore } from './extensionProfileStore.js';
import { skillPath, type SkillFile } from './skillBundles.js';

/** Native GitHub client owns credentials. The remote request supplies only exact immutable provenance. */
export async function importExactGitSkill(store: ExtensionProfileStore, actor: string, source: { repository: string; commit: string; directory: string }, guard: () => Promise<void>) {
  skillPath(source.directory); await guard();
  // Resolve the configured native installation client, never a relay-supplied credential.
  const { getAuthenticatedOctokit } = await import('../auth/githubAuth.js');
  const github: Octokit = await getAuthenticatedOctokit();
  const [owner, repo] = source.repository.split('/');
  const pinned = (await github.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { owner, repo, commit_sha: source.commit, request: { timeout: EXTENSION_LIMITS.timeoutMs } })).data;
  if (pinned.sha !== source.commit) throw new Error('Unavailable');
  await guard();
  const tree = (await github.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { owner, repo, tree_sha: pinned.tree.sha, recursive: '1', request: { timeout: EXTENSION_LIMITS.timeoutMs } })).data;
  if (tree.truncated || tree.tree.length > 10000) throw new Error('Unavailable');
  const entries = tree.tree.filter(e => e.path?.startsWith(source.directory + '/') && e.type !== 'tree');
  if (!entries.length || entries.length > EXTENSION_LIMITS.files || entries.some(e => e.type !== 'blob' || !['100644', '100755'].includes(e.mode ?? '') || !e.sha || (e.size ?? EXTENSION_LIMITS.bytes + 1) > EXTENSION_LIMITS.bytes) || entries.reduce((n, e) => n + (e.size ?? 0), 0) > EXTENSION_LIMITS.bytes) throw new Error('Unavailable');
  const files: SkillFile[] = []; let bytes = 0;
  for (const entry of entries) {
    await guard();
    const blob = (await github.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { owner, repo, file_sha: entry.sha!, request: { timeout: EXTENSION_LIMITS.timeoutMs } })).data;
    if (blob.encoding !== 'base64') throw new Error('Unavailable');
    const content = blob.content.replace(/\s/g, ''); const raw = Buffer.from(content, 'base64'); bytes += raw.length;
    if (raw.length !== entry.size || createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw])).digest('hex') !== entry.sha) throw new Error('Unavailable');
    if (bytes > EXTENSION_LIMITS.bytes) throw new Error('Unavailable');
    files.push({ path: entry.path!.slice(source.directory.length + 1), content });
  }
  await guard(); return store.importSkill(actor, files, { kind: 'github', ...source }, guard);
}
