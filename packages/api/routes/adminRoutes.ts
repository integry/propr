import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { getBootstrapAdminUsernames, type InstanceAuthorization, type InstanceRole } from '../authorization.js';
import { InstanceMemberError, InstanceMemberService } from '../instanceMemberService.js';
import type { GitHubUser } from '../authTypes.js';

interface ResolvedGitHubUser {
    id: string;
    username: string;
}

interface AdminRouteServices {
    resolveGitHubUser: (username: string, accessToken?: string) => Promise<ResolvedGitHubUser>;
}

interface AdminRoutesDeps {
    database?: Knex;
    services?: Partial<AdminRouteServices>;
}

const GITHUB_USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

async function resolveGitHubUser(username: string, accessToken?: string): Promise<ResolvedGitHubUser> {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'ProPR',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        }
    });
    if (response.status === 404) {
        throw new InstanceMemberError(`GitHub user "${username}" was not found`, 404, 'GITHUB_USER_NOT_FOUND');
    }
    if (!response.ok) {
        throw new InstanceMemberError(
            `GitHub user lookup failed with status ${response.status}`,
            502,
            'GITHUB_USER_LOOKUP_FAILED'
        );
    }
    const profile = await response.json() as { id: number; login: string };
    return { id: String(profile.id), username: profile.login };
}

function requestContext(req: Request, res: Response): {
    user: GitHubUser;
    authorization: InstanceAuthorization;
} | null {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    if (!req.authorization) {
        res.status(500).json({ error: 'Instance authorization was not resolved' });
        return null;
    }
    return { user: req.user, authorization: req.authorization };
}

function parseRole(value: unknown): InstanceRole | null {
    return value === 'admin' || value === 'member' ? value : null;
}

function sendAdminError(error: unknown, res: Response): void {
    if (error instanceof InstanceMemberError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
    }
    console.error('Instance member administration failed:', error);
    res.status(500).json({ error: 'Instance member administration failed' });
}

export function createAdminRoutes({ database = db, services: overrides }: AdminRoutesDeps = {}) {
    const service = new InstanceMemberService(database);
    const services: AdminRouteServices = { resolveGitHubUser, ...overrides };

    async function listMembers(req: Request, res: Response): Promise<void> {
        try {
            res.json({
                members: await service.listMembers(),
                bootstrapAdmins: getBootstrapAdminUsernames(),
                legacyMode: req.authorization?.legacyMode === true
            });
        } catch (error) {
            sendAdminError(error, res);
        }
    }

    async function listRoleAudit(req: Request, res: Response): Promise<void> {
        const requestedLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
        try {
            res.json({ entries: await service.listAudit(requestedLimit) });
        } catch (error) {
            sendAdminError(error, res);
        }
    }

    async function claimAdmin(req: Request, res: Response): Promise<void> {
        const context = requestContext(req, res);
        if (!context) return;
        try {
            res.json({ member: await service.claimAdmin(context.user, context.authorization) });
        } catch (error) {
            sendAdminError(error, res);
        }
    }

    async function addMember(req: Request, res: Response): Promise<void> {
        const context = requestContext(req, res);
        if (!context) return;
        const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
        const role = parseRole(req.body?.role);
        if (!GITHUB_USERNAME_PATTERN.test(username)) {
            res.status(400).json({ error: 'A valid GitHub username is required', code: 'INVALID_GITHUB_USERNAME' });
            return;
        }
        if (!role) {
            res.status(400).json({ error: 'role must be "admin" or "member"', code: 'INVALID_INSTANCE_ROLE' });
            return;
        }
        try {
            const target = await services.resolveGitHubUser(username, context.user.accessToken);
            const member = await service.addMember(context.user, context.authorization, target, role);
            res.status(201).json({ member });
        } catch (error) {
            sendAdminError(error, res);
        }
    }

    async function updateMemberRole(req: Request, res: Response): Promise<void> {
        const context = requestContext(req, res);
        if (!context) return;
        const role = parseRole(req.body?.role);
        if (!role) {
            res.status(400).json({ error: 'role must be "admin" or "member"', code: 'INVALID_INSTANCE_ROLE' });
            return;
        }
        try {
            const member = await service.updateRole(
                context.user,
                context.authorization,
                req.params.githubUserId,
                role
            );
            res.json({ member });
        } catch (error) {
            sendAdminError(error, res);
        }
    }

    async function removeMember(req: Request, res: Response): Promise<void> {
        const context = requestContext(req, res);
        if (!context) return;
        try {
            await service.removeMember(context.user, context.authorization, req.params.githubUserId);
            res.status(204).end();
        } catch (error) {
            sendAdminError(error, res);
        }
    }

    return {
        listMembers,
        listRoleAudit,
        claimAdmin,
        addMember,
        updateMemberRole,
        removeMember
    };
}
