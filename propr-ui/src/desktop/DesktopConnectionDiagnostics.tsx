import { useEffect, useRef } from 'react';
import type { ExperienceState } from './desktopExperienceState';

export function DesktopConnectionDiagnostics({ state, platform, onClose }: {
  state: ExperienceState; platform: string; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const version = 'result' in state && 'version' in state.result ? state.result.version : undefined;
  return (
    <dialog ref={dialog} className="desktop-profile-manager rounded-xl border border-slate-200 p-6 text-slate-800 shadow-xl backdrop:bg-black/30" onCancel={onClose} onClose={onClose} aria-labelledby="connection-diagnostics-title">
      <h2 id="connection-diagnostics-title" className="text-xl font-semibold">Connection Diagnostics</h2>
      <dl className="my-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt>Desktop version</dt><dd>{__APP_VERSION__}</dd>
        <dt>Platform</dt><dd>{platform}</dd>
        <dt>Connection state</dt><dd>{state.phase}</dd>
        <dt>Network</dt><dd>{navigator.onLine ? 'Online' : 'Offline'}</dd>
        <dt>Instance version</dt><dd>{version ?? 'Not available'}</dd>
        <dt>Connection type</dt><dd>{'profile' in state ? state.profile.kind : 'No instance selected'}</dd>
      </dl>
      <p className="max-w-md text-sm text-slate-600">For connection issues, check your network and use File → Switch Account / Instance to reconnect. Help → Connection Help contains setup and pairing guidance. Include these version details when reporting a problem.</p>
      <form method="dialog" className="mt-4"><button className="desktop-primary-button" autoFocus>Close</button></form>
    </dialog>
  );
}
