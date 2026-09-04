import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, ChevronRight, LoaderCircle, TriangleAlert } from 'lucide-react';
import { DesktopBrand } from './DesktopExperiencePanels';

export type PackagedAcceptanceSetupSurface = 'prerequisites' | 'error' | 'completion';

export const packagedAcceptanceSetupSurface = (): PackagedAcceptanceSetupSurface | null => {
  if (typeof window === 'undefined'
    || typeof window.__PROPR_PACKAGED_ACCEPTANCE__ !== 'object'
    || window.__PROPR_PACKAGED_ACCEPTANCE__ === null) return null;
  if (window.__PROPR_PACKAGED_ACCEPTANCE_SCENARIO__ === 'setup-error') return 'error';
  if (window.__PROPR_PACKAGED_ACCEPTANCE_SCENARIO__ === 'setup-complete') return 'completion';
  return 'prerequisites';
};

export const PackagedAcceptanceLocalSetup: React.FC<{
  initial: PackagedAcceptanceSetupSurface;
  onBack(): void;
}> = ({ initial, onBack }) => {
  const [step, setStep] = useState(0);
  const [installing, setInstalling] = useState(false);

  if (initial === 'error') {
    return (
      <main className="desktop-connection-card" aria-live="polite">
        <DesktopBrand />
        <div className="desktop-connection-visual desktop-offline"><TriangleAlert aria-hidden="true" /></div>
        <span className="desktop-eyebrow">Local setup</span>
        <h1>Setup needs attention</h1>
        <p>Docker Engine is not reachable. Start Docker Engine, then retry setup.</p>
        <div className="desktop-inline-error" role="alert">The local prerequisites need attention.</div>
        <button type="button" className="desktop-link-button" onClick={onBack}><ArrowLeft aria-hidden="true" /> Back</button>
      </main>
    );
  }

  if (initial === 'completion') {
    return (
      <main className="desktop-connection-card" aria-live="polite">
        <DesktopBrand />
        <div className="desktop-connection-visual desktop-ready"><CheckCircle2 aria-hidden="true" /></div>
        <span className="desktop-eyebrow">Local setup complete</span>
        <h1>ProPR is ready</h1>
        <p>Your private local workspace and services are ready on this computer.</p>
        <div className="desktop-connect-verified" role="status">Local services are healthy.</div>
        <button type="button" className="desktop-link-button" onClick={onBack}><ArrowLeft aria-hidden="true" /> Back</button>
      </main>
    );
  }

  if (installing) {
    return (
      <main className="desktop-connection-card" aria-live="polite">
        <DesktopBrand />
        <div className="desktop-connection-visual desktop-connecting"><LoaderCircle aria-hidden="true" /></div>
        <span className="desktop-eyebrow">Local setup</span>
        <h1>Setting up ProPR</h1>
        <p>Preparing deterministic service images and starting the private local workspace…</p>
        <div className="desktop-version-note" role="status">Environment checks passed. Preparing local services…</div>
      </main>
    );
  }

  const checks = [
    'Docker Engine is available',
    'Private workspace selected',
    'Repository access reviewed',
    'Webhook credentials protected',
    'Local services confirmed',
  ];
  return (
    <main className="desktop-welcome-card" aria-live="polite">
      <DesktopBrand />
      <button type="button" className="desktop-back-button" onClick={onBack}><ArrowLeft aria-hidden="true" /> Back</button>
      <span className="desktop-eyebrow">Local setup</span>
      <h1>Check the essentials</h1>
      <p>Review the private local workspace requirements before ProPR starts its services.</p>
      <div className="desktop-recents" role="status">
        <strong>{checks[Math.min(step, checks.length - 1)]}</strong>
        <small>Step {Math.min(step + 1, checks.length)} of {checks.length}</small>
      </div>
      {step < checks.length ? (
        <button type="button" className="desktop-primary-button" onClick={() => setStep(value => value + 1)}>
          Continue <ChevronRight aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className="desktop-primary-button" onClick={() => setInstalling(true)}>
          Install ProPR
        </button>
      )}
    </main>
  );
};
