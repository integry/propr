import { IndexingUpdatePayload, IndexingPhase } from '@propr/shared';
import { RepositoryIndexingStatus } from '../api/proprApi';

// Helper function to map WebSocket payload phase to indexing status
export const mapPhaseToIndexingStatus = (phase: IndexingPhase): 'idle' | 'indexing' | 'completed' | 'failed' => {
  if (phase === 'files' || phase === 'directories' || phase === 'indexing') {
    return 'indexing';
  }
  if (phase === 'completed') {
    return 'completed';
  }
  if (phase === 'failed') {
    return 'failed';
  }
  return 'idle';
};

// Helper to determine valid phase from payload
const getValidPhase = (
  payloadPhase: string,
  prevPhase: 'files' | 'directories' | 'completed' | undefined
): 'files' | 'directories' | 'completed' => {
  if (payloadPhase === 'files' || payloadPhase === 'directories' || payloadPhase === 'completed') {
    return payloadPhase;
  }
  return prevPhase ?? 'files';
};

const shouldRetainProgress = (phase: IndexingPhase): boolean => {
  return phase === 'indexing' || phase === 'files' || phase === 'directories' || phase === 'completed';
};

// Helper to build progress object with defaults
const buildProgressObject = (
  payload: IndexingUpdatePayload,
  prevProgress: RepositoryIndexingStatus['progress'] | undefined,
  validPhase: 'files' | 'directories' | 'completed'
): RepositoryIndexingStatus['progress'] => ({
  totalFiles: payload.totalFiles ?? prevProgress?.totalFiles ?? 0,
  processedFiles: payload.processedFiles ?? prevProgress?.processedFiles ?? 0,
  percentComplete: payload.progress ?? prevProgress?.percentComplete ?? 0,
  inputTokens: prevProgress?.inputTokens ?? 0,
  outputTokens: prevProgress?.outputTokens ?? 0,
  phase: validPhase,
  totalDirectories: payload.totalDirectories ?? prevProgress?.totalDirectories ?? 0,
  processedDirectories: payload.processedDirectories ?? prevProgress?.processedDirectories ?? 0
});

const buildCompletedProgressObject = (
  payload: IndexingUpdatePayload
): RepositoryIndexingStatus['progress'] => ({
  totalFiles: payload.totalFiles ?? 0,
  processedFiles: payload.processedFiles ?? 0,
  percentComplete: 100,
  inputTokens: 0,
  outputTokens: 0,
  phase: 'completed',
  totalDirectories: payload.totalDirectories ?? 0,
  processedDirectories: payload.processedDirectories ?? 0
});

// Helper function to build updated repository status from WebSocket payload
export const buildUpdatedStatus = (
  payload: IndexingUpdatePayload,
  prevStatus: RepositoryIndexingStatus | undefined
): RepositoryIndexingStatus => {
  const validPhase = getValidPhase(payload.phase, prevStatus?.progress?.phase);
  return {
    ...prevStatus,
    full_name: payload.repository,
    branch: payload.branch || prevStatus?.branch || 'HEAD',
    indexing_status: mapPhaseToIndexingStatus(payload.phase),
    last_indexed_at: prevStatus?.last_indexed_at ?? null,
    last_indexed_hash: prevStatus?.last_indexed_hash ?? null,
    last_indexed_commit_message: prevStatus?.last_indexed_commit_message ?? null,
    progress: shouldRetainProgress(payload.phase)
      ? payload.phase === 'completed'
        ? buildCompletedProgressObject(payload)
        : buildProgressObject(payload, prevStatus?.progress, validPhase)
      : undefined
  };
};
