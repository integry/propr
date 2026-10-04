import { useCallback, useRef, useState } from 'react';
import { getAgentTankStatus, updateAgentTankSettings } from '../../api/revertApi';
import type { AgentTankSettings } from './AgentTankSection';

/**
 * Give the backend time to settle the stored mode before asking whether it
 * works; a bundled run in particular is not ready the instant the write
 * returns. The delay is measured from the write completing, not from the click.
 */
export const STATUS_PROBE_DELAY = 500;

const INITIAL_SETTINGS: AgentTankSettings = { mode: 'disabled', enabled: false, url: '' };

/**
 * Agent Tank mode state and its optimistic write.
 *
 * Split out of `useSettingsState` because the write has to be able to undo its
 * own optimistic update: a backend can legitimately refuse a mode - an older
 * one cannot honor `bundled` at all - and the radio group must then show the
 * mode that is really persisted instead of the one that was clicked.
 *
 * Writes are queued rather than fired independently. `updateAgentTankSettings`
 * awaits a compatibility GET before POSTing `bundled`, and the URL field writes
 * on every keystroke, so concurrent writes would reach the backend in an order
 * unrelated to the operator's clicks and could persist the mode they moved away
 * from - most damagingly leaving tracking on after it was switched off.
 *
 * The availability probe follows the same queue: it only runs once the write it
 * belongs to has succeeded, because the backend answers for the mode it has
 * stored, not for the one on screen.
 *
 * @param reportError - called with `null` when a write starts and with a
 * message when it fails, so the settings page can surface it.
 */
export function useAgentTankSettings(reportError: (message: string | null) => void) {
  const [settings, setSettings] = useState<AgentTankSettings>(INITIAL_SETTINGS);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  /**
   * Monotonic id of the newest selection. Anything that finishes late - a
   * failed write's rollback, a delayed status probe - compares against this
   * before touching state, so it can only speak for the selection it belongs to.
   */
  const selectionRef = useRef(0);
  /** What the backend last confirmed, i.e. what a rollback must restore. */
  const persistedRef = useRef<AgentTankSettings>(INITIAL_SETTINGS);
  /** Tail of the write queue; never rejects, so the queue cannot stall. */
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const probeStatus = useCallback((delayMs = 0, selection = selectionRef.current) => {
    setCheckingStatus(true);
    const probe = () => {
      // A probe for a superseded selection would answer about a mode nobody has
      // selected any more; the newer selection owns these three states.
      if (selection !== selectionRef.current) return;
      getAgentTankStatus()
        .then(status => { if (selection === selectionRef.current) setAvailable(status.available); })
        .catch(() => { if (selection === selectionRef.current) setAvailable(false); })
        .finally(() => { if (selection === selectionRef.current) setCheckingStatus(false); });
    };
    if (delayMs > 0) setTimeout(probe, delayMs); else probe();
  }, []);

  /** Adopt the settings just loaded from the backend. */
  const adopt = useCallback((loaded: AgentTankSettings) => {
    const selection = ++selectionRef.current;
    persistedRef.current = loaded;
    setSettings(loaded);
    if (loaded.mode !== 'disabled') probeStatus(0, selection);
    // Bumping the selection above muted any probe still in flight, so nothing
    // else would clear the spinner.
    else setCheckingStatus(false);
  }, [probeStatus]);

  const change = useCallback((newSettings: AgentTankSettings) => {
    const selection = ++selectionRef.current;
    // A blank URL is only an external editing draft. Leaving that draft must
    // retain the saved URL so selecting External again can actually save.
    const preserveUrl = newSettings.mode !== 'external' && newSettings.url.trim() === '';
    const selectionSettings = {
      ...newSettings,
      url: preserveUrl ? persistedRef.current.url : newSettings.url,
    };
    setSettings(selectionSettings);
    setAvailable(null);
    reportError(null);
    // Clearing the URL is an intermediate edit, not a saveable external
    // configuration. Keep the draft (and its selection id) so older writes and
    // probes cannot replace it; the next non-blank edit resumes saving.
    if (newSettings.mode === 'external' && newSettings.url.trim() === '') {
      setCheckingStatus(false);
      return;
    }
    // No probe yet: until this selection is actually persisted the backend still
    // runs the mode being replaced, so a status answer would describe that one -
    // reporting "bundled unavailable" because bundled was never stored. The
    // spinner goes up now so the indicator reads as pending rather than as a
    // verdict while the write waits its turn in the queue.
    setCheckingStatus(newSettings.mode !== 'disabled');

    writeQueueRef.current = writeQueueRef.current.then(async () => {
      try {
        // Resolve preserved values at the head of the queue: an earlier write
        // may have confirmed a different URL while this selection was waiting.
        const saved = {
          ...newSettings,
          url: preserveUrl ? persistedRef.current.url : newSettings.url.trim(),
        };
        await updateAgentTankSettings({ mode: saved.mode, url: saved.url });
        persistedRef.current = saved;
        // The backend now holds this mode, so a probe can finally speak for it -
        // unless a newer selection has taken over the indicator in the meantime.
        if (selection !== selectionRef.current) return;
        setSettings(saved);
        if (newSettings.mode !== 'disabled') probeStatus(STATUS_PROBE_DELAY, selection);
      } catch (err) {
        console.error('Failed to save Agent Tank settings:', err);
        // A newer selection is already displayed, either queued behind this
        // write or held as a URL draft: rolling back to
        // this write's predecessor, or reporting an error about a mode the
        // operator has since replaced, would describe a selection that no longer
        // exists.
        if (selection !== selectionRef.current) return;
        // Retire the rejected selection before restoring: that mutes anything
        // still owed to it and gives the restored mode a selection of its own,
        // because the availability on screen has to describe what the backend
        // really holds - which is once again what was persisted.
        const restored = ++selectionRef.current;
        const persisted = persistedRef.current;
        setSettings(persisted);
        reportError((err as Error).message || 'Failed to save Agent Tank settings');
        if (persisted.mode !== 'disabled') probeStatus(0, restored);
        else setCheckingStatus(false);
      }
    });
  }, [probeStatus, reportError]);

  return { settings, available, checkingStatus, adopt, change };
}
