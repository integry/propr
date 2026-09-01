/**
 * Runtime projection generated from `codex-cli 0.146.0 app-server generate-ts
 * --experimental`. Keeping the small consumed surface here makes protocol
 * drift reviewable without vendoring the multi-megabyte complete schema.
 */
export const CODEX_APP_SERVER_0146 = Object.freeze({
    protocol: 'app-server-0.146.0',
    methods: Object.freeze({
        initialize: 'initialize',
        initialized: 'initialized',
        modelList: 'model/list',
        threadList: 'thread/list',
        threadStart: 'thread/start',
        threadResume: 'thread/resume',
    }),
    initializeCapabilities: Object.freeze({
        experimentalApi: false,
        requestAttestation: false,
    }),
});

export interface CodexInitializeResponse0146 {
    userAgent: string;
    codexHome: string;
    platformFamily: string;
    platformOs: string;
}

export interface CodexThreadIdentity0146 {
    id: string;
    sessionId: string;
    cwd: string;
    source: string;
}

