import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { isDemoMode } from './demoMode.js';
import type { GitHubUser } from './authTypes.js';

export const INSTANCE_PERMISSIONS = [
    'instance.manage_agents',
    'instance.manage_members',
    'instance.manage_runtime',
    'instance.manage_settings'
] as const;

export type InstancePermission = typeof INSTANCE_PERMISSIONS[number];
export type InstanceRole = 'admin' | 'member';
export type AuthorizationSource = 'bootstrap' | 'legacy' | 'local' | 'managed' | 'implicit' | 'demo';

export interface InstanceAuthorization {
    role: InstanceRole;
    permissions: InstancePermission[];
    source: AuthorizationSource;
    legacyMode: boolean;
}

interface InstanceMemberRow {
    github_user_id: string;
    role: InstanceRole;
    source: 'local' | 'bootstrap' | 'managed';
}

const ADMIN_PERMISSIONS: InstancePermission[] = [...INSTANCE_PERMISSIONS];
const LEGACY_ADMIN_PERMISSIONS: InstancePermission[] = INSTANCE_PERMISSIONS.filter(
    permission => permission !== 'instance.manage_runtime'
);

export function getBootstrapAdminUsernames(): string[] {
    return [...new Set(
        (process.env.PROPR_ADMIN_USERS || '')
            .split(',')
            .map(value => value.trim().toLowerCase())
            .filter(Boolean)
    )];
}

function isBootstrapAdmin(username: string): boolean {
    return getBootstrapAdminUsernames().includes(username.trim().toLowerCase());
}

export async function resolveInstanceAuthorization(
    user: GitHubUser,
    database: Knex = db
): Promise<InstanceAuthorization> {
    if (isDemoMode()) {
        return { role: 'member', permissions: [], source: 'demo', legacyMode: false };
    }

    const [member, anyMember] = await Promise.all([
        database<InstanceMemberRow>('instance_members')
            .select('github_user_id', 'role', 'source')
            .where({ github_user_id: user.id })
            .first(),
        database<InstanceMemberRow>('instance_members').select('github_user_id').first()
    ]);
    const legacyMode = !anyMember;

    if (isBootstrapAdmin(user.username)) {
        return { role: 'admin', permissions: [...ADMIN_PERMISSIONS], source: 'bootstrap', legacyMode };
    }
    if (member) {
        const permissions = member.role === 'admin' ? [...ADMIN_PERMISSIONS] : [];
        return { role: member.role, permissions, source: member.source, legacyMode };
    }
    if (legacyMode) {
        return { role: 'admin', permissions: [...LEGACY_ADMIN_PERMISSIONS], source: 'legacy', legacyMode: true };
    }
    return { role: 'member', permissions: [], source: 'implicit', legacyMode: false };
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
    if (
        permission === 'instance.manage_runtime'
        && req.user
        && /^(1|true|yes)$/i.test(process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER || '')
    ) {
        return true;
    }
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

export interface AuthenticatedUserResponse {
    id: string;
    login?: string;
    username: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    role: InstanceRole;
    permissions: InstancePermission[];
    authorizationSource: AuthorizationSource;
    legacyAdminMode: boolean;
}

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
        authorizationSource: authorization.source,
        legacyAdminMode: authorization.legacyMode
    };
}
