export function resolveAntigravityProtocolError(
    terminalStatus: 'success' | 'error' | undefined,
    protocolError: string | undefined,
    hasStreamEnvelopes: boolean,
): string | undefined {
    if (protocolError) return protocolError;
    if (terminalStatus === 'error') return 'Antigravity reported an ERROR result';
    if (hasStreamEnvelopes && terminalStatus !== 'success') {
        return 'Antigravity stream ended without a terminal SUCCESS result';
    }
    return undefined;
}
