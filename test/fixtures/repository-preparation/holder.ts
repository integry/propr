// Holds the repository preparation gate in its own process until the parent says to release it.
import { simpleGit } from 'simple-git';
import { withRepositoryPreparation } from '../../../packages/core/src/git/repositoryPreparation.js';

await withRepositoryPreparation(simpleGit(process.argv[2]), common => new Promise<void>(resolve => {
    process.once('message', () => resolve());
    process.send!({ held: common });
}));
process.send!({ released: true });
process.disconnect();
