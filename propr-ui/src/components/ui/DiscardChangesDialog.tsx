import React from 'react';
import { AgentConfirmDialog } from '../Agents/AgentConfirmDialog';

export interface DiscardQuestion {
  /** The dialog's heading, e.g. "Discard this unsaved task?". */
  title: string;
  /** What is lost, in one sentence. */
  message: string;
  /** The button that goes ahead, e.g. "Discard" or "Replace". */
  confirmLabel?: string;
}

/**
 * Asks before a form with typed content is closed, replaced or overwritten,
 * in the app's own dialog rather than the browser's `window.confirm`. Escape
 * or "Keep editing" leaves everything as it was.
 */
export const DiscardChangesDialog: React.FC<DiscardQuestion & { onConfirm: () => void; onCancel: () => void }> = ({
  title, message, confirmLabel = 'Discard', onConfirm, onCancel,
}) => (
  <AgentConfirmDialog title={title} confirmLabel={confirmLabel} cancelLabel="Keep editing" tone="danger" onConfirm={onConfirm} onCancel={onCancel}>
    <p data-testid="discard-changes-message">{message}</p>
  </AgentConfirmDialog>
);
