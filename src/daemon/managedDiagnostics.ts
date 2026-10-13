import { loadAgents } from '@propr/core';
import { DiagnosticPolicyError, collectProvider, managedDiagnostics, nativeDiagnosticStatus, diagnosticsFailure, providerCredentialRoot } from '@propr/core/diagnostics';

/** Daemon measures native inventories; workers own capture with run credentials.
 * Only configured managed roots and explicit launcher mounts are eligible. */
export function scheduleManagedDiagnostics(): () => void {
    try { if (!managedDiagnostics()) return () => {}; }
    catch (error) {
        if (error instanceof DiagnosticPolicyError) throw error;
        diagnosticsFailure();
    }
    let running = false, nextAgent = 0;
    const collect = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            const spool = managedDiagnostics()!;
            // Independent metadata inventory: no archive/export or native disposal.
            nativeDiagnosticStatus();
            // Standing limitations are recorded when they begin or change, not on
            // every pass, so repeated inventories add no duplicate gap noise.
            spool.report({ provider: 'claude', agent: 'unknown', source: 'shared-tmp-claude-logs' }, 'ownership-unverified', 0, { standing: true });
            const agents = (await loadAgents()).filter(a => a.enabled);
            const inventory = { provider: 'application', agent: 'application', source: 'agent-inventory' };
            spool.report(inventory, 'protected-native-state', 0);
            if (agents.length > 128) spool.report(inventory, 'scan-limit', 0, { standing: true });
            const deadline = performance.now() + 2000;
            const count = Math.min(agents.length, 128);
            for (let visited = 0; visited < count; visited++) {
                if (performance.now() > deadline) {
                    spool.report(inventory, 'scan-limit', 0, { standing: true });
                    break;
                }
                const agent = agents[nextAgent % count];
                nextAgent = (nextAgent + 1) % count;
                // Default per-provider resolution, as at capture (Codex keeps its own resolver).
                const root = providerCredentialRoot({ provider: agent.type, agent: agent.id, configPath: agent.configPath });
                if (!root) {
                    spool.report({ provider: agent.type, agent: agent.id, source: 'unmapped-native-state' }, 'ownership-unverified', 0, { standing: true });
                    continue;
                }
                collectProvider(spool, { provider: agent.type, agent: agent.id, root,
                    credentials: [], measureOnly: true });
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        } catch { diagnosticsFailure(); }
        finally { running = false; }
    };
    void collect();
    const timer = setInterval(() => { void collect(); }, 30_000);
    timer.unref();
    return () => clearInterval(timer);
}
