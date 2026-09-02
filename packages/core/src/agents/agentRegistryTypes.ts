export interface AgentRegistryOperationalStatus {
    unifiedAgentImage: {
        status: 'ready' | 'unavailable';
        imageTag?: string;
        error?: string;
        recordedAt?: string;
    };
}
