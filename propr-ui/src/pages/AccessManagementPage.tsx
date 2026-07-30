import React, { useCallback, useEffect, useState } from 'react';
import { History, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import {
  addInstanceMember,
  claimBootstrapAdmin,
  getInstanceMembers,
  getInstanceRoleAudit,
  removeInstanceMember,
  updateInstanceMemberRole
} from '../api/instanceMembersApi';
import type {
  InstanceMember,
  InstanceMembersResponse,
  InstanceRole,
  InstanceRoleAuditEntry
} from '../api/proprTypes';
import { useCurrentUser, useRefreshCurrentUser } from '../contexts/AuthContext';

const EMPTY_RESPONSE: InstanceMembersResponse = {
  members: [],
  bootstrapAdmins: []
};

function auditDescription(entry: InstanceRoleAuditEntry): string {
  if (entry.action === 'admin_claimed') return 'stored an administrator role for';
  if (entry.action === 'member_added') return `added ${entry.newRole ?? 'a role'} for`;
  if (entry.action === 'member_removed') return `removed ${entry.previousRole ?? 'the role'} from`;
  if (entry.action === 'role_changed') {
    return `changed ${entry.previousRole ?? 'the role'} to ${entry.newRole ?? 'unassigned'} for`;
  }
  return `${entry.action.replace(/_/g, ' ')} for`;
}

const AccessManagementPage: React.FC = () => {
  const currentUser = useCurrentUser();
  const refreshCurrentUser = useRefreshCurrentUser();
  const [data, setData] = useState<InstanceMembersResponse>(EMPTY_RESPONSE);
  const [auditEntries, setAuditEntries] = useState<InstanceRoleAuditEntry[]>([]);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<InstanceRole>('member');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadMembers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getInstanceMembers());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load instance roles');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      setAuditEntries(await getInstanceRoleAudit());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load role audit');
    }
  }, []);

  useEffect(() => {
    void loadMembers();
    void loadAudit();
  }, [loadAudit, loadMembers]);

  const runMutation = async (mutation: () => Promise<unknown>) => {
    setSaving(true);
    setError('');
    try {
      await mutation();
      await refreshCurrentUser();
      await Promise.all([loadMembers(), loadAudit()]);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Role update failed');
    } finally {
      setSaving(false);
    }
  };

  const addMember = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername) return;
    await runMutation(async () => {
      await addInstanceMember(normalizedUsername, role);
      setUsername('');
    });
  };

  const updateRole = (member: InstanceMember, nextRole: InstanceRole) => {
    if (member.role === nextRole) return;
    void runMutation(() => updateInstanceMemberRole(member.githubUserId, nextRole));
  };

  const removeMember = (member: InstanceMember) => {
    if (!window.confirm(`Remove the explicit role assignment for @${member.githubUsername}?`)) return;
    void runMutation(() => removeInstanceMember(member.githubUserId));
  };

  const canStoreBootstrapRole = currentUser?.authorizationSource === 'bootstrap'
    && !data.members.some(member => member.githubUserId === currentUser.id && member.role === 'admin');

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex items-start gap-3">
        <div className="rounded-lg bg-red-50 p-2 text-primary-600">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Instance access</h1>
          <p className="mt-1 text-sm text-gray-600">
            Administrators manage installation settings. Members can use ProPR but cannot change the installation.
          </p>
        </div>
      </div>

      {data.bootstrapAdmins.length > 0 && (
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          Environment administrators: {data.bootstrapAdmins.map(name => `@${name}`).join(', ')}.
          These assignments remain authoritative while <code>PROPR_ADMIN_USERS</code> is configured.
        </div>
      )}

      {canStoreBootstrapRole && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="font-medium text-amber-900">Store your administrator role</h2>
          <p className="mt-1 text-sm text-amber-800">
            Your access currently comes from <code>PROPR_ADMIN_USERS</code>. Store it against your numeric
            GitHub ID before removing your username from that environment setting.
          </p>
          <button
            type="button"
            disabled={saving}
            onClick={() => void runMutation(claimBootstrapAdmin)}
            className="mt-3 rounded-md bg-amber-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Store my administrator role
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={addMember} className="mb-8 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="font-medium text-gray-900">Add explicit role assignment</h2>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="flex-1">
            <span className="sr-only">GitHub username</span>
            <input
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="GitHub username"
              autoComplete="off"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </label>
          <label>
            <span className="sr-only">Instance role</span>
            <select
              value={role}
              onChange={event => setRole(event.target.value as InstanceRole)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={saving || !username.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            <UserPlus className="h-4 w-4" />
            Add user
          </button>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Role assignments do not alter the GitHub trigger whitelist. Add allowed trigger actors in Settings separately.
        </p>
      </form>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-5 py-4">
          <h2 className="font-medium text-gray-900">Explicit assignments</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading access assignments…</div>
        ) : data.members.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No durable assignments yet.</div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {data.members.map(member => {
              return (
                <li key={member.githubUserId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900">
                      @{member.githubUsername}
                      {member.githubUserId === currentUser?.id && (
                        <span className="ml-2 text-xs font-normal text-gray-500">(you)</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      GitHub ID {member.githubUserId} · source: {member.source}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Role for ${member.githubUsername}`}
                      value={member.role}
                      disabled={saving}
                      onChange={event => updateRole(member, event.target.value as InstanceRole)}
                      className="rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Administrator</option>
                    </select>
                    <button
                      type="button"
                      aria-label={`Remove ${member.githubUsername}`}
                      title="Remove durable assignment"
                      disabled={saving}
                      onClick={() => removeMember(member)}
                      className="rounded-md p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-8 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-4">
          <History className="h-4 w-4 text-gray-500" />
          <h2 className="font-medium text-gray-900">Recent role changes</h2>
        </div>
        {auditEntries.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">No role changes recorded yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {auditEntries.map(entry => (
              <li key={entry.id} className="px-5 py-3 text-sm text-gray-700">
                <span className="font-medium">@{entry.actorGithubUsername}</span>
                {' '}{auditDescription(entry)}{' '}
                <span className="font-medium">@{entry.targetGithubUsername}</span>
                <span className="ml-2 text-xs text-gray-500">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default AccessManagementPage;
