import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import {
    INSTANCE_PERMISSIONS,
    type AuthenticatedInstanceUser,
    type InstanceAuthorizationSource,
    type InstanceMemberSource,
    type InstancePermission,
    type InstanceRole
} from '@propr/shared';
import { isDemoMode } from './demoMode.js';
import type { GitHubUser } from './authTypes.js';

export { INSTANCE_PERMISSIONS };
export type { InstancePermission, InstanceRole };

export interface InstanceAuthorization {
    role: InstanceRole;
    permissions: InstancePermission[];
    source: InstanceAuthorizationSource;
}

interface InstanceMemberRow {
    github_user_id: string;
    role: InstanceRole;
    source: InstanceMemberSource;
}

const ADMIN_PERMISSIONS: InstancePermission[] = [...INSTANCE_PERMISSIONS];

export function getBootstrapAdminUsernames(): string[] {
    return [...new Set(
        (process.env.PROPR_ADMIN_USERS || '')
            .split(',')
            .map(value => value.trim().toLowerCase())
            .filter(Boolean)
    )];
}

export function isBootstrapAdmin(username: string): boolean {
    return getBootstrapAdminUsernames().includes(username.trim().toLowerCase());
}

export async function resolveInstanceAuthorization(
    user: GitHubUser,
    database: Knex = db
): Promise<InstanceAuthorization> {
    if (isDemoMode()) {
        return { role: 'member', permissions: [], source: 'demo' };
    }

    // Environment administrators do not require a database lookup. Besides
    // keeping the break-glass path independent of the database, this avoids an
    // authorization query on every request made by a bootstrap installation
    // administrator.
    if (isBootstrapAdmin(user.username)) {
        return { role: 'admin', permissions: [...ADMIN_PERMISSIONS], source: 'bootstrap' };
    }

    // Keep this single primary-key lookup uncached so demotions and removals
    // take effect on the next request.
    const member = await database<InstanceMemberRow>('instance_members')
        .select('github_user_id', 'role', 'source')
        .where({ github_user_id: user.id })
        .first();
    if (member) {
        const permissions = member.role === 'admin' ? [...ADMIN_PERMISSIONS] : [];
        return { role: member.role, permissions, source: member.source };
    }
    return { role: 'member', permissions: [], source: 'implicit' };
}

export async function resolveAuthorization(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }
    try {
        req.authorization = await resolveInstanceAuthorization(req.user);
        next();
    } catch (error) {
        console.error('Failed to resolve instance authorization:', error);
        res.status(500).json({ error: 'Failed to resolve instance authorization' });
    }
}

export function hasPermission(req: Request, permission: InstancePermission): boolean {
    return req.authorization?.permissions.includes(permission) === true;
}

export function requirePermission(permission: InstancePermission): RequestHandler {
    return (req, res, next) => {
        if (hasPermission(req, permission)) {
            next();
            return;
        }
        res.status(403).json({
            error: 'Forbidden',
            code: 'INSUFFICIENT_INSTANCE_PERMISSION',
            message: `This action requires the ${permission} permission.`
        });
    };
}

export type AuthenticatedUserResponse = AuthenticatedInstanceUser;

export function authenticatedUserResponse(
    user: GitHubUser,
    authorization: InstanceAuthorization
): AuthenticatedUserResponse {
    return {
        id: user.id,
        login: user.login,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        role: authorization.role,
        permissions: [...authorization.permissions],
        authorizationSource: authorization.source
    };
}
