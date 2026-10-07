/**
 * Dependency injection for the check_run status lookups used by Ultrafix
 * readiness gating. Wired once at startup by the worker, daemon and API.
 */

import type { UltrafixCheckStatus } from './ultrafixOrchestrationService.js';

export type ChecksPassingFn = (owner: string, repo: string, ref: string) => Promise<boolean>;
export type GetPRHeadFn = (owner: string, repo: string, pr: number) => Promise<string | null>;
export type GetCheckRunsStatusFn = (owner: string, repo: string, ref: string) => Promise<UltrafixCheckStatus>;

export interface CheckRunDeps {
    areAllChecksPassing: ChecksPassingFn | null;
    getCurrentPRHead: GetPRHeadFn | null;
    getCheckRunsStatus: GetCheckRunsStatusFn | null;
}

let _areAllChecksPassing: ChecksPassingFn | null = null;
let _getCurrentPRHead: GetPRHeadFn | null = null;
let _getCheckRunsStatus: GetCheckRunsStatusFn | null = null;

export function setCheckRunDeps(deps: {
    areAllChecksPassing: ChecksPassingFn;
    getCurrentPRHead: GetPRHeadFn;
    getCheckRunsStatus?: GetCheckRunsStatusFn;
}): void {
    _areAllChecksPassing = deps.areAllChecksPassing;
    _getCurrentPRHead = deps.getCurrentPRHead;
    _getCheckRunsStatus = deps.getCheckRunsStatus ?? null;
}

export function getCheckRunDeps(): CheckRunDeps {
    return {
        areAllChecksPassing: _areAllChecksPassing,
        getCurrentPRHead: _getCurrentPRHead,
        getCheckRunsStatus: _getCheckRunsStatus,
    };
}
