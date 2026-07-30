export const INSTANCE_PERMISSIONS = [
  'instance.manage_agents',
  'instance.manage_members',
  'instance.manage_runtime',
  'instance.manage_settings',
] as const;

export type InstancePermission = typeof INSTANCE_PERMISSIONS[number];
export type InstanceRole = 'admin' | 'member';
export type InstanceAuthorizationSource = 'bootstrap' | 'local' | 'managed' | 'implicit' | 'demo';
export type InstanceMemberSource = 'local' | 'managed';

export interface AuthenticatedInstanceUser {
  id: string;
  login?: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  role: InstanceRole;
  permissions: InstancePermission[];
  authorizationSource: InstanceAuthorizationSource;
}

export interface InstanceMember {
  githubUserId: string;
  githubUsername: string;
  role: InstanceRole;
  source: InstanceMemberSource;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstanceRoleAuditEntry {
  id: number;
  actorGithubUserId: string;
  actorGithubUsername: string;
  targetGithubUserId: string;
  targetGithubUsername: string;
  action: string;
  previousRole: InstanceRole | null;
  newRole: InstanceRole | null;
  createdAt: string;
}

export interface InstanceMembersResponse {
  members: InstanceMember[];
  bootstrapAdmins: string[];
}
