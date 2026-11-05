import type { PublicationWrite, RetryPublicationOutcome } from './issueRetryRequest.js';

/**
 * Durable evidence of a trigger write's outcome that the route learned but
 * could not record with its request. It outlives the process that learned it
 * and any job carrying it, until a delivery's dispatch or a later follow-up
 * records the outcome. It names the write by its request and when the write
 * began, so it never confirms another write of a restarted request.
 */
export interface RetryOutcomeEvidence {
  save(write: PublicationWrite, publication: RetryPublicationOutcome): Promise<void>;
  read(write: PublicationWrite): Promise<RetryPublicationOutcome | null>;
  clear(write: PublicationWrite): Promise<void>;
}

interface EvidenceClient {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

const evidenceKey = (write: PublicationWrite) => `issue:retry-outcome:${write.id}:${write.publishedAt}`;

/** Evidence kept in Redis without expiry: only recording the outcome it evidences drops it. */
export function redisRetryOutcomeEvidence(client: () => EvidenceClient | Promise<EvidenceClient>): RetryOutcomeEvidence {
  return {
    save: async (write, publication) => { await (await client()).set(evidenceKey(write), publication); },
    read: async write => {
      const publication = await (await client()).get(evidenceKey(write));
      return publication === 'possible' || publication === 'refused' ? publication : null;
    },
    clear: async write => { await (await client()).del(evidenceKey(write)); },
  };
}
