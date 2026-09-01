import type { SupervisedDockerExecution, SupervisedDockerOutput } from '../../claude/docker/dockerExecutor.js';
import type { GoalContainerOutputObserver } from './GoalContainerSupervisor.js';
import type { GoalProviderDuplexTransport } from './providerOperationBoundary.js';
import { GoalSessionContractError } from './errors.js';

const DEFAULT_PROTOCOL_QUEUE_BYTES = 2 * 1024 * 1024;

/**
 * One-use bridge from the isolated container's exact stdout chunks to a
 * provider parser.  Raw bytes live only in this bounded in-memory queue.  They
 * are never copied into durable events, JSONL, errors, or host-log tails.
 */
export function createProviderProtocolDuplex(
    maxQueuedBytes = DEFAULT_PROTOCOL_QUEUE_BYTES,
): {
    observer: GoalContainerOutputObserver;
    bindExecution(execution: SupervisedDockerExecution): void;
    transport: GoalProviderDuplexTransport;
} {
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
        throw new GoalSessionContractError('Protocol queue bound is invalid', 'UNSAFE_PROVIDER_VALUE');
    }
    const queue: string[] = [];
    const waiters: Array<{
        resolve(result: IteratorResult<string>): void;
        reject(error: GoalSessionContractError): void;
    }> = [];
    let queuedBytes = 0;
    let execution: SupervisedDockerExecution | undefined;
    let ended = false;
    let failure: GoalSessionContractError | undefined;
    let subscribed = true;

    const finish = (error?: GoalSessionContractError): void => {
        if (ended) return;
        ended = true;
        failure = error;
        while (waiters.length) {
            const waiter = waiters.shift()!;
            if (error) waiter.reject(error);
            else waiter.resolve({ done: true, value: undefined });
        }
    };
    const next = async (): Promise<IteratorResult<string>> => {
        if (failure) throw failure;
        const value = queue.shift();
        if (value !== undefined) {
            queuedBytes -= Buffer.byteLength(value);
            return { done: false, value };
        }
        if (ended) return { done: true, value: undefined };
        return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    };
    const push = (output: Readonly<SupervisedDockerOutput>): void | 'unsubscribe' => {
        if (!subscribed || ended) return 'unsubscribe';
        if (output.channel !== 'stdout') return;
        const chunk = output.data;
        const bytes = Buffer.byteLength(chunk);
        if (queuedBytes + bytes > maxQueuedBytes) {
            subscribed = false;
            const error = new GoalSessionContractError(
                'Provider protocol exceeded its bounded in-memory queue', 'PROVIDER_OPERATION_FAILED',
            );
            finish(error);
            void execution?.cancel(error).catch(() => undefined);
            return 'unsubscribe';
        }
        const waiter = waiters.shift();
        if (waiter) waiter.resolve({ done: false, value: chunk });
        else {
            queue.push(chunk);
            queuedBytes += bytes;
        }
    };

    const observer: GoalContainerOutputObserver = {
        next: push,
        complete: () => finish(),
        error: () => finish(new GoalSessionContractError(
            'Supervised provider protocol failed safely', 'PROVIDER_OPERATION_FAILED',
        )),
    };
    const transport: GoalProviderDuplexTransport = {
        output: {
            [Symbol.asyncIterator]: () => ({
                next,
                return: async () => {
                    subscribed = false;
                    finish();
                    return { done: true, value: undefined };
                },
            }),
        },
        async write(message: string): Promise<void> {
            if (!execution) throw new GoalSessionContractError(
                'Provider protocol transport is not bound', 'PROVIDER_OPERATION_FAILED',
            );
            await execution.writeInput(message);
        },
        closeInput(): void { execution?.closeInput(); },
        async cancel(): Promise<void> {
            subscribed = false;
            finish();
            await execution?.cancel(new GoalSessionContractError(
                'Provider protocol cancelled safely', 'PROVIDER_OPERATION_FAILED',
            ));
        },
        get completion() {
            return execution?.completion ?? Promise.reject(new GoalSessionContractError(
                'Provider protocol transport is not bound', 'PROVIDER_OPERATION_FAILED',
            ));
        },
    };
    return {
        observer,
        bindExecution(value): void {
            if (execution) throw new GoalSessionContractError(
                'Provider protocol transport is already bound', 'PROVIDER_OPERATION_FAILED',
            );
            execution = value;
        },
        transport,
    };
}
