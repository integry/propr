/**
 * Loads a file's blob from the git object database for bounded reading.
 */

import { createHooklessGit } from '../git/hooklessGit.js';
import { RepositoryRetrievalError } from './repositoryRetrievalTypes.js';

/** Blobs above this size are refused before being loaded into memory. */
const MAX_BLOB_BYTES = 20 * 1024 * 1024;
/** Longest symlink target quoted in an error. */
const MAX_SYMLINK_TARGET_CHARS = 1024;

/**
 * Returns the text of `filePath` at `commit`: 404 when absent, 400 for a
 * directory or symbolic link, 413 above MAX_BLOB_BYTES, and 500 when git
 * fails to read an object that exists.
 */
export async function readBlob(repoPath: string, commit: string, filePath: string, repository: string): Promise<string> {
  const git = createHooklessGit(repoPath);
  const object = `${commit}:${filePath}`;

  let type: string;
  try {
    type = (await git.raw(['cat-file', '-t', object])).trim();
  } catch {
    throw new RepositoryRetrievalError(`File "${filePath}" not found in ${repository} at ${commit.slice(0, 12)}`, 404);
  }
  if (type !== 'blob') {
    throw new RepositoryRetrievalError(`"${filePath}" is a ${type === 'tree' ? 'directory' : type}, not a file`, 400);
  }

  // The object exists, so any failure below is a local git problem.
  const localGit = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RepositoryRetrievalError) throw error;
      throw new RepositoryRetrievalError(`Failed to read "${filePath}": ${(error as Error)?.message ?? String(error)}`, 500);
    }
  };

  const size = Number.parseInt((await localGit(() => git.raw(['cat-file', '-s', object]))).trim(), 10);
  if (Number.isFinite(size) && size > MAX_BLOB_BYTES) {
    throw new RepositoryRetrievalError(`File "${filePath}" is too large to read (${size} bytes)`, 413);
  }

  // simple-git resolves a git failure that printed nothing to stderr (such as
  // a corrupt object) with empty output, so the delivered size is checked.
  const blob = await localGit(() => git.showBuffer([object]));
  if (Number.isFinite(size) && blob.length !== size) {
    throw new RepositoryRetrievalError(`Failed to read "${filePath}": git returned ${blob.length} of ${size} bytes`, 500);
  }
  const content = blob.toString('utf8');
  // A symlink is stored as a blob holding its target path; returning that as
  // file content would misreport it.
  const entries = await localGit(() => git.raw(['--literal-pathspecs', 'ls-tree', '-z', commit, '--', filePath]));
  const isSymlink = entries.split('\0').some(entry => entry.startsWith('120000 ') && entry.slice(entry.indexOf('\t') + 1) === filePath);
  if (isSymlink) {
    const target = content.length > MAX_SYMLINK_TARGET_CHARS ? `${content.slice(0, MAX_SYMLINK_TARGET_CHARS)}...` : content;
    throw new RepositoryRetrievalError(`"${filePath}" is a symbolic link to "${target}", not a file; read the link target instead`, 400);
  }
  return content;
}
