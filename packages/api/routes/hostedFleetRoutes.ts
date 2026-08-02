import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { getBootstrapAdminUsernames } from '../authorization.js';

interface HostedFleetRoutesDeps {
    database?: Knex;
    fleetSecret?: string;
    initialAdminGithubUserId?: string;
    initialAdminGithubLogin?: string;
    githubUserWhitelist?: string;
    operationalStatus?: (req: Request, res: Response) => void | Promise<void>;
    queueStatus?: (req: Request, res: Response) => void | Promise<void>;
}

export function isHostedFleetControlEnabled(
    fleetSecret: string | undefined = process.env.PROPR_FLEET_CONTROL_SECRET
): fleetSecret is string {
    return Boolean(fleetSecret && fleetSecret.length >= 32);
}

function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createHostedFleetRoutes({
    database = db,
    fleetSecret = process.env.PROPR_FLEET_CONTROL_SECRET,
    initialAdminGithubUserId = process.env.PROPR_HOSTED_INITIAL_ADMIN_GITHUB_USER_ID,
    initialAdminGithubLogin = process.env.PROPR_HOSTED_INITIAL_ADMIN_GITHUB_LOGIN,
    githubUserWhitelist = process.env.GITHUB_USER_WHITELIST,
    operationalStatus,
    queueStatus,
}: HostedFleetRoutesDeps = {}) {
    function isAuthorized(req: Request): boolean {
        const supplied = req.get('x-propr-fleet-secret') ?? '';
        return isHostedFleetControlEnabled(fleetSecret) && safeEqual(supplied, fleetSecret);
    }

    async function getBootstrapStatus(req: Request, res: Response): Promise<void> {
        if (!isAuthorized(req)) {
            res.status(401).json({ error: 'Fleet authentication required' });
            return;
        }
        if (!initialAdminGithubUserId || !/^\d+$/.test(initialAdminGithubUserId)) {
            res.status(409).json({ error: 'Hosted initial administrator is not configured' });
            return;
        }

        const durableAdmin = await database('instance_members')
            .select('github_user_id')
            .where({ github_user_id: initialAdminGithubUserId, role: 'admin' })
            .first();
        const normalizedLogin = initialAdminGithubLogin?.trim().toLowerCase() ?? '';
        const environmentBootstrapActive = normalizedLogin.length > 0
            && getBootstrapAdminUsernames().some(username => username.toLowerCase() === normalizedLogin);
        const whitelist = (githubUserWhitelist ?? '')
            .split(',')
            .map(username => username.trim().toLowerCase())
            .filter(Boolean);

        res.setHeader('Cache-Control', 'no-store');
        res.json({
            initialAdminGithubUserId,
            durableAdminVerified: Boolean(durableAdmin),
            environmentBootstrapActive,
            whitelistOnlyInitialOwner: normalizedLogin.length > 0
                && whitelist.length === 1
                && whitelist[0] === normalizedLogin,
        });
    }

    async function getOperationalStatus(req: Request, res: Response): Promise<void> {
        if (!isAuthorized(req)) {
            res.status(401).json({ error: 'Fleet authentication required' });
            return;
        }
        if (!operationalStatus) {
            res.status(503).json({ error: 'Operational status is unavailable' });
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        await operationalStatus(req, res);
    }

    async function getQueueStatus(req: Request, res: Response): Promise<void> {
        if (!isAuthorized(req)) {
            res.status(401).json({ error: 'Fleet authentication required' });
            return;
        }
        if (!queueStatus) {
            res.status(503).json({ error: 'Queue status is unavailable' });
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        await queueStatus(req, res);
    }

    return { getBootstrapStatus, getOperationalStatus, getQueueStatus };
}
