import type { Job, Worker } from 'bullmq';
import type {
    CommentJobData,
    IssueJobData,
    JobResult,
    MergeConflictJobData,
    SystemTaskJobData,
    TaskImportJobData,
} from '@propr/core';

export type MainJobData = IssueJobData | CommentJobData | TaskImportJobData | SystemTaskJobData | MergeConflictJobData;
export type MainWorker = Worker<MainJobData, JobResult>;

export interface MainJobProcessors {
    processGitHubIssueJob: (job: Job<IssueJobData>) => Promise<JobResult>;
    processPullRequestCommentJob: (job: Job<CommentJobData>) => Promise<JobResult>;
    processTaskImportJob: (job: Job<TaskImportJobData>) => Promise<JobResult>;
    processSystemTaskJob: (job: Job<SystemTaskJobData>) => Promise<JobResult>;
    processMergeConflictJob: (job: Job<MergeConflictJobData>) => Promise<JobResult>;
}

export type MainWorkerFactory = (
    queueName: string,
    processor: (job: Job<MainJobData>) => Promise<JobResult>,
    options: { concurrency: number; autorun: boolean },
) => Promise<MainWorker>;

export function createMainJobProcessor(processors: MainJobProcessors) {
    return async (job: Job<MainJobData>): Promise<JobResult> => {
        switch (job.name) {
            case 'processGitHubIssue':
                return processors.processGitHubIssueJob(job as Job<IssueJobData>);
            case 'processPullRequestComment':
                return processors.processPullRequestCommentJob(job as Job<CommentJobData>);
            case 'processTaskImport':
                return processors.processTaskImportJob(job as Job<TaskImportJobData>);
            case 'processSystemTask':
                return processors.processSystemTaskJob(job as Job<SystemTaskJobData>);
            case 'processMergeConflict':
                return processors.processMergeConflictJob(job as Job<MergeConflictJobData>);
            default:
                throw new Error(`Unknown job type: ${job.name}`);
        }
    };
}

export async function createConfiguredMainWorker(options: {
    queueName: string;
    concurrency: number;
    workerFactory: MainWorkerFactory;
    processors: MainJobProcessors;
    beforeRun?: (worker: MainWorker) => void;
}): Promise<MainWorker> {
    const worker = await options.workerFactory(
        options.queueName,
        createMainJobProcessor(options.processors),
        { concurrency: options.concurrency, autorun: false },
    );
    options.beforeRun?.(worker);
    void worker.run().catch(error => worker.emit('error', error));
    return worker;
}
