import { createHash, timingSafeEqual } from 'node:crypto';
import type { Application, Request, Response } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { getBootstrapAdminUsernames } from '../authorization.js';

interface HostedFleetRoutesDeps {
    database?: Knex;
    fleetSecret?: string;
    initialAdminGithubUserId?: string;
    initialAdminGithubLogin?: string;
    githubUserWhitelist?: string;
    bootstrapAdminUsernames?: readonly string[];
    operationalStatus?: () => unknown | Promise<unknown>;
    queueStatus?: () => unknown | Promise<unknown>;
}

interface FleetOperationalStatus {
    githubAuthMode: string;
    githubAuth: string;
    githubEventIntake: string;
    githubEventIntakeStatus: string;
}

interface FleetQueueStatus {
    waiting: number;
    active: number;
}

const MAX_GITHUB_USER_ID_DIGITS = 20;
const GITHUB_AUTH_MODES = new Set(['app', 'relay', 'demo', 'none', 'unknown']);
const GITHUB_AUTH_STATUSES = new Set(['connected', 'disconnected']);
const GITHUB_EVENT_INTAKE_MODES = new Set(['routing_websocket', 'polling', 'direct_webhook', 'unknown']);
const GITHUB_EVENT_INTAKE_STATUSES = new Set(['connected', 'disconnected', 'active', 'unknown']);

export function isHostedFleetControlEnabled(
    fleetSecret: string | undefined = process.env.PROPR_FLEET_CONTROL_SECRET
): fleetSecret is string {
    return Boolean(fleetSecret && fleetSecret.length >= 32);
}

function safeEqual(left: string, right: string): boolean {
    const leftDigest = createHash('sha256').update(left).digest();
    const rightDigest = createHash('sha256').update(right).digest();
    return timingSafeEqual(leftDigest, rightDigest);
}

function canonicalizeGithubUserId(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.length > MAX_GITHUB_USER_ID_DIGITS || !/^\d+$/.test(trimmed)) return undefined;
    const canonical = trimmed.replace(/^0+(?=\d)/, '');
    return canonical === '0' ? undefined : canonical;
}

function normalizeUsernames(usernames: readonly string[]): Set<string> {
    return new Set(usernames.map(username => username.trim().toLowerCase()).filter(Boolean));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOperationalStatus(value: unknown): FleetOperationalStatus | undefined {
    if (!isRecord(value)) return undefined;
    const { githubAuthMode, githubAuth, githubEventIntake, githubEventIntakeStatus } = value;
    if (
        typeof githubAuthMode !== 'string'
        || !GITHUB_AUTH_MODES.has(githubAuthMode)
        || typeof githubAuth !== 'string'
        || !GITHUB_AUTH_STATUSES.has(githubAuth)
        || typeof githubEventIntake !== 'string'
        || !GITHUB_EVENT_INTAKE_MODES.has(githubEventIntake)
        || typeof githubEventIntakeStatus !== 'string'
        || !GITHUB_EVENT_INTAKE_STATUSES.has(githubEventIntakeStatus)
    ) {
        return undefined;
    }
    return { githubAuthMode, githubAuth, githubEventIntake, githubEventIntakeStatus };
}

function parseQueueStatus(value: unknown): FleetQueueStatus | undefined {
    if (!isRecord(value)) return undefined;
    const { waiting, active } = value;
    if (
        typeof waiting !== 'number'
        || !Number.isSafeInteger(waiting)
        || waiting < 0
        || typeof active !== 'number'
        || !Number.isSafeInteger(active)
        || active < 0
    ) {
        return undefined;
    }
    return { waiting, active };
}

export function createHostedFleetRoutes({
    database = db,
    fleetSecret = process.env.PROPR_FLEET_CONTROL_SECRET,
    initialAdminGithubUserId = process.env.PROPR_HOSTED_INITIAL_ADMIN_GITHUB_USER_ID,
    initialAdminGithubLogin = process.env.PROPR_HOSTED_INITIAL_ADMIN_GITHUB_LOGIN,
    githubUserWhitelist = process.env.GITHUB_USER_WHITELIST,
    bootstrapAdminUsernames = getBootstrapAdminUsernames(),
    operationalStatus,
    queueStatus,
}: HostedFleetRoutesDeps = {}) {
    const canonicalInitialAdminGithubUserId = canonicalizeGithubUserId(initialAdminGithubUserId);
    const normalizedLogin = initialAdminGithubLogin?.trim().toLowerCase() ?? '';
    const normalizedBootstrapAdmins = normalizeUsernames(bootstrapAdminUsernames);
    const normalizedWhitelist = normalizeUsernames((githubUserWhitelist ?? '').split(','));

    function isAuthorized(req: Request): boolean {
        const supplied = req.get('x-propr-fleet-secret') ?? '';
        return isHostedFleetControlEnabled(fleetSecret) && safeEqual(supplied, fleetSecret);
    }

    async function getBootstrapStatus(req: Request, res: Response): Promise<void> {
        res.setHeader('Cache-Control', 'no-store');
        if (!isAuthorized(req)) {
            res.status(401).json({ error: 'Fleet authentication required' });
            return;
        }
        if (!canonicalInitialAdminGithubUserId) {
            res.status(409).json({ error: 'Hosted initial administrator is not configured' });
            return;
        }

        let durableAdminVerified: boolean;
        try {
            const durableAdmin = await database('instance_members')
                .select('github_user_id')
                .where({ github_user_id: canonicalInitialAdminGithubUserId, role: 'admin' })
                .first();
            durableAdminVerified = Boolean(durableAdmin);
        } catch (error) {
            console.error('Failed to collect hosted Fleet bootstrap status:', error);
            res.status(503).json({ error: 'Bootstrap status is unavailable' });
            return;
        }
        const environmentBootstrapActive = normalizedLogin.length > 0
            && normalizedBootstrapAdmins.has(normalizedLogin);

        res.json({
            initialAdminGithubUserId: canonicalInitialAdminGithubUserId,
            durableAdminVerified,
            environmentBootstrapActive,
            bootstrapOnlyInitialOwner: normalizedLogin.length > 0
                && normalizedBootstrapAdmins.size === 1
                && normalizedBootstrapAdmins.has(normalizedLogin),
            whitelistOnlyInitialOwner: normalizedLogin.length > 0
                && normalizedWhitelist.size === 1
                && normalizedWhitelist.has(normalizedLogin),
        });
    }

    async function getOperationalStatus(req: Request, res: Response): Promise<void> {
        res.setHeader('Cache-Control', 'no-store');
        if (!isAuthorized(req)) {
            res.status(401).json({ error: 'Fleet authentication required' });
            return;
        }
        if (!operationalStatus) {
            res.status(503).json({ error: 'Operational status is unavailable' });
            return;
        }
        try {
            const status = parseOperationalStatus(await operationalStatus());
            if (!status) {
                res.status(503).json({ error: 'Operational status is unavailable' });
                return;
            }
            res.json(status);
        } catch (error) {
            console.error('Failed to collect hosted Fleet operational status:', error);
            res.status(503).json({ error: 'Operational status is unavailable' });
        }
    }

    async function getQueueStatus(req: Request, res: Response): Promise<void> {
        res.setHeader('Cache-Control', 'no-store');
        if (!isAuthorized(req)) {
            res.status(401).json({ error: 'Fleet authentication required' });
            return;
        }
        if (!queueStatus) {
            res.status(503).json({ error: 'Queue status is unavailable' });
            return;
        }
        try {
            const status = parseQueueStatus(await queueStatus());
            if (!status) {
                res.status(503).json({ error: 'Queue status is unavailable' });
                return;
            }
            res.json(status);
        } catch (error) {
            console.error('Failed to collect hosted Fleet queue status:', error);
            res.status(503).json({ error: 'Queue status is unavailable' });
        }
    }

    return { getBootstrapStatus, getOperationalStatus, getQueueStatus };
}

export function registerHostedFleetRoutes(
    app: Pick<Application, 'get'>,
    deps: HostedFleetRoutesDeps = {}
): boolean {
    const fleetSecret = deps.fleetSecret ?? process.env.PROPR_FLEET_CONTROL_SECRET;
    if (!isHostedFleetControlEnabled(fleetSecret)) return false;

    const routes = createHostedFleetRoutes({ ...deps, fleetSecret });
    app.get('/api/internal/hosted/bootstrap', routes.getBootstrapStatus);
    app.get('/api/internal/hosted/status', routes.getOperationalStatus);
    app.get('/api/internal/hosted/queue', routes.getQueueStatus);
    return true;
}
