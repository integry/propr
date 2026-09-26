/**
 * Allow the active owner of a push delivery job to extend its live lease.
 *
 * The notification schema migration also contains this transition for new
 * installations. Replacing the trigger here applies the same invariant to
 * databases that recorded that migration before lease renewal was added.
 */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function validTransitionTriggerSql(allowLeaseRenewal) {
  const leaseRenewalTransition = allowLeaseRenewal
    ? `
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'processing'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.next_retry_at IS OLD.next_retry_at
        AND NEW.claim_token IS OLD.claim_token
        AND NEW.claimed_at IS OLD.claimed_at
        AND OLD.lease_expires_at > ${ISO_NOW_SQL}
        AND NEW.lease_expires_at > OLD.lease_expires_at
      )`
    : '';

  return `
    CREATE TRIGGER push_delivery_jobs_valid_transition
    BEFORE UPDATE ON push_delivery_jobs
    WHEN NOT (
      (
        NEW.status = OLD.status
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.next_retry_at IS OLD.next_retry_at
        AND NEW.claim_token IS OLD.claim_token
        AND NEW.claimed_at IS OLD.claimed_at
        AND NEW.lease_expires_at IS OLD.lease_expires_at
      )
      OR (
        OLD.status IN ('pending', 'retryable')
        AND NEW.status = 'processing'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.claimed_at <= ${ISO_NOW_SQL}
        AND NEW.lease_expires_at > ${ISO_NOW_SQL}
        AND (
          (OLD.status = 'pending' AND OLD.created_at <= ${ISO_NOW_SQL}
            AND NEW.claimed_at >= OLD.created_at)
          OR (OLD.status = 'retryable' AND OLD.next_retry_at <= ${ISO_NOW_SQL}
            AND NEW.claimed_at >= OLD.next_retry_at)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = OLD.attempt_count + 1
        )
      )${leaseRenewalTransition}
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'processing'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.claim_token IS NOT OLD.claim_token
        AND OLD.lease_expires_at <= ${ISO_NOW_SQL}
        AND NEW.claimed_at >= OLD.lease_expires_at
        AND NEW.claimed_at <= ${ISO_NOW_SQL}
        AND NEW.lease_expires_at > ${ISO_NOW_SQL}
        AND NOT EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = OLD.attempt_count + 1
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status IN ('delivered', 'retryable', 'failed')
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = NEW.attempt_count
            AND attempt.claim_token = OLD.claim_token
            AND attempt.status = NEW.status
            AND (
              NEW.status != 'retryable'
              OR attempt.next_retry_at = NEW.next_retry_at
            )
        )
      )
      OR (
        OLD.status IN ('pending', 'retryable')
        AND NEW.status = 'cancelled'
        AND NEW.attempt_count = OLD.attempt_count
        AND NOT EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = OLD.attempt_count + 1
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'cancelled'
        AND NEW.attempt_count = OLD.attempt_count
        AND OLD.lease_expires_at <= ${ISO_NOW_SQL}
        AND NOT EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = OLD.attempt_count + 1
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'cancelled'
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = NEW.attempt_count
            AND attempt.claim_token = OLD.claim_token
            AND attempt.status = 'retryable'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM push_subscriptions AS subscription
          WHERE subscription.subscription_id = OLD.subscription_id
            AND subscription.user_id = OLD.user_id
            AND subscription.revoked_at IS NULL
            AND (
              subscription.expires_at IS NULL
              OR subscription.expires_at > ${ISO_NOW_SQL}
            )
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid push delivery job transition');
    END
  `;
}

async function replaceValidTransitionTrigger(knex, allowLeaseRenewal) {
  await knex.transaction(async (transaction) => {
    await transaction.raw('DROP TRIGGER IF EXISTS push_delivery_jobs_valid_transition');
    await transaction.raw(validTransitionTriggerSql(allowLeaseRenewal));
  });
}

export async function up(knex) {
  await replaceValidTransitionTrigger(knex, true);
}

export async function down(knex) {
  await replaceValidTransitionTrigger(knex, false);
}
