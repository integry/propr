import React, { useCallback, useEffect, useRef, useState } from 'react';
import { History, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import {
  addInstanceMember,
  claimBootstrapAdmin,
  getInstanceMembers,
  getInstanceRoleAudit,
  removeInstanceMember,
  updateInstanceMemberRole
} from '../api/instanceMembersApi';
import {
  addToTriggerWhitelist,
  getTriggerWhitelist,
  isLoginInWhitelist,
  removeFromTriggerWhitelist
} from '../api/triggerWhitelistApi';
import type {
  InstanceMember,
  InstanceMembersResponse,
  InstanceRole,
  InstanceRoleAuditEntry
} from '../api/proprTypes';
import { useCurrentUser, useRefreshCurrentUser } from '../contexts/AuthContext';
import { ListSkeleton } from '../components/ui/Skeleton';

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

interface WhitelistOffer {
  action: 'add' | 'remove';
  username: string;
}

type CollectionState = 'refreshing' | 'loading' | 'error' | 'empty' | 'ready';

function getCollectionState(loading: boolean, itemCount: number, error: string): CollectionState {
  if (loading) return itemCount > 0 ? 'refreshing' : 'loading';
  if (error && itemCount === 0) return 'error';
  return itemCount === 0 ? 'empty' : 'ready';
}

const AccessManagementPage: React.FC = () => {
  const currentUser = useCurrentUser();
  const refreshCurrentUser = useRefreshCurrentUser();
  const [data, setData] = useState<InstanceMembersResponse>(EMPTY_RESPONSE);
  const [auditEntries, setAuditEntries] = useState<InstanceRoleAuditEntry[]>([]);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<InstanceRole>('member');
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [auditError, setAuditError] = useState('');
  const [triggerWhitelist, setTriggerWhitelist] = useState<string[] | null>(null);
  const [whitelistOffer, setWhitelistOffer] = useState<WhitelistOffer | null>(null);
  const membersRequestIdRef = useRef(0);
  const auditRequestIdRef = useRef(0);

  const loadMembers = useCallback(async () => {
    const requestId = ++membersRequestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const response = await getInstanceMembers();
      if (requestId === membersRequestIdRef.current) setData(response);
    } catch (loadError) {
      if (requestId === membersRequestIdRef.current) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load instance roles');
      }
    } finally {
      if (requestId === membersRequestIdRef.current) setLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    const requestId = ++auditRequestIdRef.current;
    setAuditLoading(true);
    setAuditError('');
    try {
      const response = await getInstanceRoleAudit();
      if (requestId === auditRequestIdRef.current) setAuditEntries(response);
    } catch (loadError) {
      if (requestId === auditRequestIdRef.current) {
        setAuditError(loadError instanceof Error ? loadError.message : 'Failed to load role audit');
      }
    } finally {
      if (requestId === auditRequestIdRef.current) setAuditLoading(false);
    }
  }, []);

  // The trigger whitelist is optional context: when it cannot be read, no whitelist offers are made.
  const loadTriggerWhitelist = useCallback(async (): Promise<string[] | null> => {
    try {
      const whitelist = await getTriggerWhitelist();
      setTriggerWhitelist(whitelist);
      return whitelist;
    } catch {
      setTriggerWhitelist(null);
      return null;
    }
  }, []);

  useEffect(() => {
    void loadMembers();
    void loadAudit();
    void loadTriggerWhitelist();
    return () => {
      membersRequestIdRef.current += 1;
      auditRequestIdRef.current += 1;
    };
  }, [loadAudit, loadMembers, loadTriggerWhitelist]);

  const runMutation = async (mutation: () => Promise<unknown>): Promise<boolean> => {
    setSaving(true);
    setError('');
    try {
      await mutation();
      await refreshCurrentUser();
      await Promise.all([loadMembers(), loadAudit()]);
      return true;
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Role update failed');
      return false;
    } finally {
      setSaving(false);
    }
  };

  // An empty whitelist lets every GitHub user trigger ProPR, so adding the first entry would lock
  // everyone else out and removing the last one would open access; neither is offered here.
  const offerWhitelistChange = async (action: WhitelistOffer['action'], githubUsername: string) => {
    const whitelist = await loadTriggerWhitelist();
    if (!whitelist || whitelist.length === 0) return;
    const listed = isLoginInWhitelist(whitelist, githubUsername);
    if (action === 'add' && !listed) setWhitelistOffer({ action, username: githubUsername });
    if (action === 'remove' && listed && whitelist.length > 1) setWhitelistOffer({ action, username: githubUsername });
  };

  const applyWhitelistOffer = async () => {
    if (!whitelistOffer) return;
    const { action, username: offerUsername } = whitelistOffer;
    setSaving(true);
    setError('');
    try {
      const updated = action === 'add'
        ? await addToTriggerWhitelist(offerUsername)
        : await removeFromTriggerWhitelist(offerUsername);
      setTriggerWhitelist(updated);
      setWhitelistOffer(null);
    } catch (whitelistError) {
      setError(whitelistError instanceof Error ? whitelistError.message : 'Trigger whitelist update failed');
    } finally {
      setSaving(false);
    }
  };

  const addMember = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername) return;
    setWhitelistOffer(null);
    let added: InstanceMember | undefined;
    const succeeded = await runMutation(async () => {
      added = await addInstanceMember(normalizedUsername, role);
      setUsername('');
    });
    if (succeeded) await offerWhitelistChange('add', added?.githubUsername ?? normalizedUsername);
  };

  const updateRole = (member: InstanceMember, nextRole: InstanceRole) => {
    if (member.role === nextRole) return;
    void runMutation(() => updateInstanceMemberRole(member.githubUserId, nextRole));
  };

  const removeMember = async (member: InstanceMember) => {
    if (!window.confirm(`Remove the instance role assigned to @${member.githubUsername}?`)) return;
    setWhitelistOffer(null);
    const succeeded = await runMutation(() => removeInstanceMember(member.githubUserId));
    if (succeeded) await offerWhitelistChange('remove', member.githubUsername);
  };

  const canStoreBootstrapRole = currentUser?.authorizationSource === 'bootstrap'
    && !data.members.some(member => member.githubUserId === currentUser.id && member.role === 'admin');
  const memberState = getCollectionState(loading, data.members.length, error);
  const auditState = getCollectionState(auditLoading, auditEntries.length, auditError);

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

      {whitelistOffer && (
        <div role="status" className="mb-6 flex flex-col gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 sm:flex-row sm:items-center">
          <p className="flex-1 text-sm text-blue-900">
            {whitelistOffer.action === 'add'
              ? <>@{whitelistOffer.username} is not on the trigger whitelist, so they cannot start ProPR tasks from GitHub. Add them to it too?</>
              : <>@{whitelistOffer.username} is still on the trigger whitelist and can start ProPR tasks from GitHub. Remove them from it too?</>}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void applyWhitelistOffer()}
              className="rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {whitelistOffer.action === 'add' ? 'Add to trigger whitelist' : 'Remove from trigger whitelist'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => setWhitelistOffer(null)}
              className="rounded-md border border-blue-200 bg-white px-3 py-2 text-sm font-medium text-blue-900 hover:bg-blue-100 disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <form onSubmit={addMember} className="mb-8 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="font-medium text-gray-900">Assign an instance role</h2>
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
          Instance roles and the GitHub trigger whitelist are separate. After adding or removing a user, you
          will be offered the matching trigger whitelist change; the full whitelist is managed in Settings.
        </p>
      </form>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-5 py-4">
          <h2 className="font-medium text-gray-900">Assigned instance roles</h2>
        </div>
        {memberState === 'loading' ? (
          <ListSkeleton rows={3} layout="row" label="Loading access assignments…" className="px-5 py-4" />
        ) : memberState === 'error' ? null
        : memberState === 'empty' ? (
          <div className="p-8 text-center text-sm text-gray-500">No instance roles assigned yet.</div>
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
                      {triggerWhitelist && triggerWhitelist.length > 0 && isLoginInWhitelist(triggerWhitelist, member.githubUsername)
                        && ' · on trigger whitelist'}
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
                      title="Remove assigned instance role"
                      disabled={saving}
                      onClick={() => void removeMember(member)}
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
        {auditError && <div role="alert" className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">{auditError}</div>}
        {auditState === 'loading' ? (
          <ListSkeleton rows={3} layout="row" label="Loading role changes…" className="px-5 py-4" />
        ) : auditState === 'error' ? null
        : auditState === 'empty' ? (
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
