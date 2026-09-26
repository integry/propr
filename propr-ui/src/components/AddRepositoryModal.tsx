// CI retrigger
import React from 'react';
import { Image, Video } from 'lucide-react';
import { BaseBranchSelector } from './BaseBranchSelector';
import type { VisualPreviewSettings } from '../hooks/repositoryVisualPreview';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface AddRepositoryModalProps {
  isOpen: boolean;
  newRepo: string;
  newAlias: string;
  newBaseBranch: string;
  autoFollowupOnFailedCi: boolean;
  visualPreview: VisualPreviewSettings;
  availableRepos: string[];
  onRepoChange: (value: string) => void;
  onAliasChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onAutoFollowupOnFailedCiChange: (value: boolean) => void;
  onVisualPreviewChange: (value: VisualPreviewSettings) => void;
  onAdd: () => void;
  onClose: () => void;
  isReadOnly?: boolean;
}

export const AddRepositoryModal: React.FC<AddRepositoryModalProps> = ({
  isOpen,
  newRepo,
  newAlias,
  newBaseBranch,
  autoFollowupOnFailedCi,
  visualPreview,
  availableRepos,
  onRepoChange,
  onAliasChange,
  onBaseBranchChange,
  onAutoFollowupOnFailedCiChange,
  onVisualPreviewChange,
  onAdd,
  onClose,
  isReadOnly = false,
}) => {
  const titleId = React.useId();
  const repositoryId = React.useId();
  const aliasId = React.useId();
  const aliasDescriptionId = React.useId();
  const baseBranchId = React.useId();
  const baseBranchLabelId = React.useId();
  const baseBranchDescriptionId = React.useId();
  const previewInstructionsId = React.useId();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const repositoryInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!isOpen) return;

    const previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    repositoryInputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const firstFocusableElement = focusableElements[0];
      const lastFocusableElement = focusableElements[focusableElements.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastFocusableElement : firstFocusableElement).focus();
      } else if (event.shiftKey && document.activeElement === firstFocusableElement) {
        event.preventDefault();
        lastFocusableElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusableElement) {
        event.preventDefault();
        firstFocusableElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    onAdd();
  };

  const togglePreviewType = (type: 'image' | 'video') => {
    const selected = visualPreview.types.includes(type);
    if (selected && visualPreview.types.length === 1) return;
    onVisualPreviewChange({
      ...visualPreview,
      types: selected ? visualPreview.types.filter(candidate => candidate !== type) : [...visualPreview.types, type]
    });
  };

  const previewTypeButtonClassName = (type: 'image' | 'video') => `inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 ${
    visualPreview.types.includes(type)
      ? 'border-teal-300 bg-teal-50 text-teal-700'
      : 'border-gray-300 bg-white text-gray-500'
  }`;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-white rounded-lg max-w-lg w-full max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden border border-gray-300 shadow-lg"
      >
        {/* Modal Header */}
        <div className="flex flex-shrink-0 justify-between items-center px-4 py-3 border-b border-gray-200">
          <h3 id={titleId} className="text-base font-semibold text-gray-900">
            Add Repository
          </h3>
          <button
            type="button"
            aria-label="Close Add Repository"
            className="-mr-1 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 text-2xl leading-none focus:outline-none focus:ring-2 focus:ring-primary-500"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        {/* Modal Content */}
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div data-testid="add-repository-modal-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
            <div>
              <label htmlFor={repositoryId} className="block text-sm font-medium text-gray-700 mb-1">Repository *</label>
              <input
                ref={repositoryInputRef}
                id={repositoryId}
                list={`${repositoryId}-options`}
                value={newRepo}
                onChange={(e) => onRepoChange(e.target.value)}
                placeholder="owner/repo"
                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                disabled={isReadOnly}
              />
              <datalist id={`${repositoryId}-options`}>
                {availableRepos.map(repo => <option key={repo} value={repo} />)}
              </datalist>
            </div>

            <div>
              <label htmlFor={aliasId} className="block text-sm font-medium text-gray-700 mb-1">Alias (optional)</label>
              <input
                id={aliasId}
                value={newAlias}
                onChange={(e) => onAliasChange(e.target.value)}
                placeholder="e.g., Production"
                aria-describedby={aliasDescriptionId}
                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                disabled={isReadOnly}
              />
              <p id={aliasDescriptionId} className="text-xs text-gray-500 mt-1">
                A friendly name to help identify this repository.
              </p>
            </div>

            <div>
              <label id={baseBranchLabelId} htmlFor={baseBranchId} className="block text-sm font-medium text-gray-700 mb-1">Base Branch (optional)</label>
              <BaseBranchSelector
                repoName={newRepo}
                value={newBaseBranch}
                onChange={onBaseBranchChange}
                placeholder="Select branch..."
                disabled={isReadOnly}
                controlId={baseBranchId}
                labelledBy={baseBranchLabelId}
                describedBy={baseBranchDescriptionId}
                menuPosition="inline"
              />
              <p id={baseBranchDescriptionId} className="text-xs text-gray-500 mt-1">
                You can add the same repository multiple times with different base branches.
              </p>
            </div>

            <label className="flex items-start gap-3 border-t border-gray-200 pt-3">
              <input
                type="checkbox"
                checked={autoFollowupOnFailedCi}
                onChange={(e) => onAutoFollowupOnFailedCiChange(e.target.checked)}
                disabled={isReadOnly}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              <span>
                <span className="block text-sm font-medium text-gray-700">Automatic CI follow-up</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  Start an automatic follow-up when this repository's CI fails.
                </span>
              </span>
            </label>

            <div>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={visualPreview.enabled}
                  onChange={(e) => onVisualPreviewChange({ ...visualPreview, enabled: e.target.checked })}
                  disabled={isReadOnly}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span>
                  <span className="block text-sm font-medium text-gray-700">Visual previews</span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    Add rendered previews of visual changes to this repository's pull requests.
                  </span>
                </span>
              </label>

              {visualPreview.enabled && (
                <div className="ml-7 mt-3 space-y-3">
                  <div role="group" aria-label="Preview types" className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => togglePreviewType('image')}
                      disabled={isReadOnly}
                      aria-pressed={visualPreview.types.includes('image')}
                      title={visualPreview.types.length === 1 && visualPreview.types.includes('image') ? 'At least one preview type is required' : 'Include image previews'}
                      className={previewTypeButtonClassName('image')}
                    >
                      <Image className="h-3 w-3" aria-hidden="true" /> Images
                    </button>
                    <button
                      type="button"
                      onClick={() => togglePreviewType('video')}
                      disabled={isReadOnly}
                      aria-pressed={visualPreview.types.includes('video')}
                      title={visualPreview.types.length === 1 && visualPreview.types.includes('video') ? 'At least one preview type is required' : 'Include video previews'}
                      className={previewTypeButtonClassName('video')}
                    >
                      <Video className="h-3 w-3" aria-hidden="true" /> Videos
                    </button>
                  </div>

                  <div>
                    <label htmlFor={previewInstructionsId} className="block text-sm font-medium text-gray-700 mb-1">Preview instructions (optional)</label>
                    <textarea
                      id={previewInstructionsId}
                      value={visualPreview.instructions || ''}
                      onChange={(e) => onVisualPreviewChange({ ...visualPreview, instructions: e.target.value })}
                      disabled={isReadOnly}
                      maxLength={4000}
                      rows={2}
                      placeholder="e.g., Capture separate desktop and mobile views"
                      className="w-full resize-y px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Modal Footer */}
          <div data-testid="add-repository-modal-footer" className="flex flex-shrink-0 justify-end gap-2 px-4 py-3 border-t border-gray-200 bg-white">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!newRepo || isReadOnly}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                !newRepo || isReadOnly
                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  : 'bg-primary-600 text-white hover:bg-primary-700'
              }`}
            >
              Add Repository
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
