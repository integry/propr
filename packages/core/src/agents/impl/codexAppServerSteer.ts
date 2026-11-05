import { randomUUID } from 'node:crypto';
import type { AppServerConnection } from './codexAppServerConnection.js';

// App Server rejects a steer whose expected turn is no longer the running one.
const STALE_STEER_PATTERN = /expected active turn id|no active turn to steer/i;

/**
 * Steers the thread's running turn. App Server continues an active goal on its
 * own, so by the time ProPR delivers input the turn it observed may have ended
 * and a newer one may be running. Returns the turn that received the input, or
 * null when no turn is running and the caller must deliver it on a later turn.
 */
export async function steerRunningTurn(
    connection: AppServerConnection,
    options: { threadId: string; turnId: string; text: string; clientUserMessageId?: string },
): Promise<string | null> {
    const { threadId, text } = options;
    const clientUserMessageId = options.clientUserMessageId ?? randomUUID();
    const tried = new Set<string>();
    let candidate: string | null = connection.isTurnFinished(options.turnId)
        ? connection.runningTurn(threadId)
        : options.turnId;
    while (candidate && !tried.has(candidate)) {
        tried.add(candidate);
        try {
            await connection.request('turn/steer', {
                threadId,
                clientUserMessageId,
                input: [{ type: 'text', text, text_elements: [] }],
                expectedTurnId: candidate,
            });
            return candidate;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!STALE_STEER_PATTERN.test(message)) throw error;
            const found = /but found `([^`]+)`/.exec(message)?.[1];
            candidate = found && !connection.isTurnFinished(found) ? found : connection.runningTurn(threadId);
        }
    }
    return null;
}
