import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getInstanceSprites, removeInstanceSprites, type InstanceSprites } from '../../api/instanceSpritesApi';
import { AgentConfirmDialog } from '../../components/Agents/AgentConfirmDialog';
import { useCurrentUser } from '../../contexts/AuthContext';
import { SettingsSection, SettingsStatus, type SettingsStatusTone } from './SettingsLayout';
import { canManageAgentRuntime } from './settingsPermissions';
import { formatDateTime } from '../../utils/dateFormat';

const plural = (count: number) => `${count} Sprite${count === 1 ? '' : 's'}`;
const button = 'inline-flex items-center gap-2 rounded border px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50';

function headerState(sprites: InstanceSprites | null, error: string | null): { tone: SettingsStatusTone; label: string } {
  if (error && !sprites) return { tone: 'error', label: 'Unavailable' };
  if (!sprites) return { tone: 'pending', label: 'Loading…' };
  if (!sprites.configured) return { tone: 'pending', label: 'No Sprites token' };
  if (sprites.count === 0) return { tone: 'ok', label: 'No Sprites' };
  return { tone: sprites.busy > 0 ? 'warn' : 'ok', label: sprites.busy > 0 ? `${plural(sprites.count)} · ${sprites.busy} in use` : plural(sprites.count) };
}

/**
 * The Sprites this instance created (`propr-<marker>-*`). They belong to the
 * Sprites organization, not the Fly app, so deleting the app leaves them
 * behind; removing them here is the step before deleting the deployment.
 */
export default function InstanceSpritesSection() {
  const user = useCurrentUser();
  if (!canManageAgentRuntime(user)) return null;
  return <InstanceSpritesControls />;
}

function SpritesDetails({ sprites }: { sprites: InstanceSprites }) {
  if (!sprites.configured) {
    return <p className="text-slate-600">No Sprites token is set on this instance (<code>SPRITES_TOKEN</code>), so there are no Sprites to list. If an earlier token created Sprites, delete those named <code>propr-&lt;marker&gt;-*</code> in the Sprites dashboard.</p>;
  }
  return (
    <>
      <p className="text-slate-600">
        {sprites.prefix
          ? <>Name prefix: <code data-testid="instance-sprites-prefix">{sprites.prefix}</code></>
          : 'This instance has not created a Sprite yet.'}
      </p>
      {sprites.count > 0 && (
        <ul className="divide-y divide-slate-100 rounded border border-slate-200" aria-label="Sprites of this instance">
          {sprites.sprites.map(sprite => (
            <li key={sprite.name} className="flex flex-wrap items-baseline justify-between gap-x-4 px-3 py-2">
              <code className="break-all text-slate-900">{sprite.name}</code>
              <span className="text-slate-500">{[sprite.status, sprite.createdAt && `created ${formatDateTime(sprite.createdAt) || sprite.createdAt}`].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
      {sprites.busy > 0 && <p className="text-amber-700">An agent run is using a Sprite. Wait for it to finish before you remove them.</p>}
    </>
  );
}

function InstanceSpritesControls() {
  const [sprites, setSprites] = useState<InstanceSprites | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  /** A reload after a removal keeps its outcome on screen; a manual refresh clears it. */
  const load = useCallback(async (clearOutcome = true) => {
    setLoading(true);
    try {
      setSprites(await getInstanceSprites());
      if (clearOutcome) { setError(null); setMessage(null); }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const remove = async () => {
    if (!sprites) return;
    setRemoving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await removeInstanceSprites(sprites.count);
      setMessage(`Removed ${plural(result.deleted)}.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRemoving(false);
      setConfirming(false);
      await load(false);
    }
  };

  const state = headerState(sprites, error);
  const canRemove = Boolean(sprites?.configured && sprites.count > 0 && sprites.busy === 0) && !removing && !loading;

  return (
    <SettingsSection
      title="Agent runtime"
      description="Sprites this instance created for agent runs. They belong to the Sprites organization of the Sprites token, not to the Fly app, so deleting the app leaves them behind and they keep using the organization's Sprite slots (3 on the Free Plan). Remove them before you delete the app."
      status={<SettingsStatus tone={state.tone} role="status">{state.label}</SettingsStatus>}
    >
      <div className="max-w-2xl space-y-4 text-[12px] leading-5" data-testid="instance-sprites">
        {sprites && <SpritesDetails sprites={sprites} />}
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {message && <p role="status" className="text-emerald-700">{message}</p>}
        <div className="flex flex-wrap items-center gap-3">
          {sprites?.configured && sprites.count > 0 && (
            <button type="button" className={`${button} border-red-300 text-red-700 hover:bg-red-50`} disabled={!canRemove} onClick={() => setConfirming(true)}>
              Remove all Sprites of this instance
            </button>
          )}
          <button type="button" className={`${button} border-slate-300 text-slate-700 hover:bg-slate-50`} disabled={loading || removing} onClick={() => void load()}>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>
      {confirming && sprites && (
        <AgentConfirmDialog
          title={`Remove ${plural(sprites.count)}?`}
          confirmLabel={removing ? 'Removing…' : `Remove ${plural(sprites.count)}`}
          tone="danger"
          busy={removing}
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        >
          <p>This deletes the {plural(sprites.count)} named <code>{sprites.prefix}*</code> from the Sprites organization, including warm checkouts. The next agent run creates a new Sprite. This cannot be undone.</p>
        </AgentConfirmDialog>
      )}
    </SettingsSection>
  );
}
