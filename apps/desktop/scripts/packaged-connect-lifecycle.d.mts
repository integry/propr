export const CONNECT_READY_EVENT: string;
export const PACKAGED_CONNECT_RECORD_MAX_COUNT: number;

export interface PackagedConnectLifecycleResult {
  ok: boolean;
  category: string;
  capture: 'complete' | 'truncated';
  records: Array<Record<string, unknown>>;
  secondary?: string[];
}

export function runPackagedConnectLifecycle(
  options: Record<string, unknown>,
): Promise<PackagedConnectLifecycleResult>;
