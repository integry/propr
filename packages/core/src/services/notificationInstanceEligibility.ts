import type { Knex } from 'knex';
import { normalizeISO8601Timestamp } from '@propr/shared';
import { db } from '../db/connection.js';

const ELIGIBILITY_TABLE = 'notification_instance_user_eligibility';

function boundedIdentity(value: string, name: string): string {
    const normalized = value.trim();
    if (!normalized || Buffer.byteLength(normalized, 'utf8') > 255) {
        throw new TypeError(`${name} must be a bounded non-empty string`);
    }
    return normalized;
}

/** Records an authorization decision made by the API access gate. */
export async function recordNotificationInstanceEligibility(options: {
    userId: string;
    githubUsername: string;
    database?: Knex;
    observedAt?: string | number | Date;
}): Promise<void> {
    const database = options.database ?? db;
    if (!await database.schema.hasTable(ELIGIBILITY_TABLE)) return;
    const userId = boundedIdentity(options.userId, 'notification eligibility userId');
    const githubUsername = boundedIdentity(
        options.githubUsername,
        'notification eligibility GitHub username'
    );
    const lastAuthorizedAt = normalizeISO8601Timestamp(options.observedAt ?? new Date());
    await database(ELIGIBILITY_TABLE).insert({
        user_id: userId,
        github_username: githubUsername,
        last_authorized_at: lastAuthorizedAt
    }).onConflict('user_id').merge({
        github_username: database.raw(`CASE
            WHEN excluded.last_authorized_at >= ${ELIGIBILITY_TABLE}.last_authorized_at
              THEN excluded.github_username
            ELSE ${ELIGIBILITY_TABLE}.github_username
        END`),
        last_authorized_at: database.raw(`MAX(
            ${ELIGIBILITY_TABLE}.last_authorized_at,
            excluded.last_authorized_at
        )`)
    });
}
