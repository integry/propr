import type {
    GoalModelChangeAcknowledgement, GoalModelChangeHistoryPort,
    GoalModelChangeRequest,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';

export async function resolveModelChangeHistory(
    historyPort: GoalModelChangeHistoryPort,
    request: GoalModelChangeRequest,
    options: { operationId: string; appliesAt: 'next_turn' | 'next_safe_boundary'; retainedIntent: boolean },
): Promise<GoalModelChangeAcknowledgement | undefined> {
    const { operationId, appliesAt, retainedIntent } = options;
    const history = await historyPort.claim(request, operationId, request.model);
    if (history.model !== request.model) {
        throw new GoalSessionContractError(
            'Model operationId was already used for a different model', 'MODEL_OPERATION_CONFLICT',
        );
    }
    if (history.status === 'retired') {
        return { outcome: 'outside_retry_horizon', requestedModel: request.model, appliesAt };
    }
    return history.status === 'settled' && history.acknowledgement && (!retainedIntent || appliesAt === 'next_turn')
        ? history.acknowledgement : undefined;
}
