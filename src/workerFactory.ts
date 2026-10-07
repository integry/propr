import type { Job, Worker } from 'bullmq';
import type {
    AgentRunJobData,
    CommentJobData,
    GoalJobData,
    IssueJobData,
    JobResult,
    MergeConflictJobData,
    SystemTaskJobData,
    TaskImportJobData,
} from '@propr/core';

export type MainJobData = IssueJobData | CommentJobData | GoalJobData | TaskImportJobData | SystemTaskJobData | MergeConflictJobData | AgentRunJobData;
export type MainWorker = Worker<MainJobData, JobResult>;

export interface MainJobProcessors {
    processGitHubIssueJob: (job: Job<IssueJobData>) => Promise<JobResult>;
    processPullRequestCommentJob: (job: Job<CommentJobData>) => Promise<JobResult>;
    processTaskImportJob: (job: Job<TaskImportJobData>) => Promise<JobResult>;
    processSystemTaskJob: (job: Job<SystemTaskJobData>) => Promise<JobResult>;
    processMergeConflictJob: (job: Job<MergeConflictJobData>) => Promise<JobResult>;
    processGoalJob: (job: Job<GoalJobData>) => Promise<JobResult>;
    processAgentRunJob: (job: Job<AgentRunJobData>) => Promise<JobResult>;
    processAgentActionJob: (job: Job<AgentRunJobData>) => Promise<JobResult>;
}

export type MainWorkerFactory = (
    queueName: string,
    processor: (job: Job<MainJobData>) => Promise<JobResult>,
    options: { concurrency: number; autorun: boolean },
) => Promise<MainWorker>;

export function createMainJobProcessor(processors: MainJobProcessors, beforeProcess?: (job: Job<MainJobData>) => Promise<JobResult | null>) {
    return async (job: Job<MainJobData>): Promise<JobResult> => {
        const stopped = await beforeProcess?.(job);
        if (stopped) return stopped;
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
            case 'processGoal':
                return processors.processGoalJob(job as Job<GoalJobData>);
            case 'processAgentRun':
                return processors.processAgentRunJob(job as Job<AgentRunJobData>);
            case 'processAgentAction':
                return processors.processAgentActionJob(job as Job<AgentRunJobData>);
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
    beforeProcess?: (job: Job<MainJobData>) => Promise<JobResult | null>;
    beforeRun?: (worker: MainWorker) => void;
}): Promise<MainWorker> {
    const worker = await options.workerFactory(
        options.queueName,
        createMainJobProcessor(options.processors, options.beforeProcess),
        { concurrency: options.concurrency, autorun: false },
    );
    options.beforeRun?.(worker);
    void worker.run().catch(error => worker.emit('error', error));
    return worker;
}
