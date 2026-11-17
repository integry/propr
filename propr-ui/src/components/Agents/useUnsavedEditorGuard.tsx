import { useCallback, useEffect, useRef } from 'react';
import { matchPath, useNavigate } from 'react-router-dom';
import type { DiscardQuestion } from '../ui/DiscardChangesDialog';
import { useDiscardConfirmation } from '../ui/useDiscardConfirmation';

export const DISCARD_AUTOMATION_QUESTION: DiscardQuestion = {
  title: 'Discard unsaved changes?',
  message: 'What you entered in this automation will be lost.',
};

/**
 * Which editor a route shows, as the automations page keys it: `new:<template>`
 * for the new-automation form, the definition id for a saved one (its runs
 * included), or null for a route that shows no editor.
 */
export function editorKeyForRoute(route: string): string | null {
  const url = new URL(route, 'http://local');
  if (matchPath('/automations/new', url.pathname)) return `new:${url.searchParams.get('template') ?? ''}`;
  const saved = matchPath('/automations/:definitionId/*', url.pathname);
  return saved?.params.definitionId ? decodeURIComponent(saved.params.definitionId) : null;
}

/** The in-app route an anchor leads to, or null for another origin; a HashRouter link carries it in its hash. */
const routeOfAnchor = (anchor: HTMLAnchorElement): string | null => {
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (url.hash.startsWith('#/')) return url.hash.slice(1);
  return `${url.pathname}${url.search}`;
};

const isPlainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Keeps typed input in the open automation from being dropped silently. The
 * editor reports whether it holds unsaved input through `setUnsaved`; while it
 * does, closing it (`guard`) and following any in-app link that would show a
 * different editor or leave the page ask first. Links that keep the same
 * editor, such as its Settings and Runs tabs, go straight through.
 */
export function useUnsavedEditorGuard(currentKey: string | null) {
  const navigate = useNavigate();
  const { confirmDiscard, dialog } = useDiscardConfirmation();
  const unsavedRef = useRef(false);
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;

  const setUnsaved = useCallback((unsaved: boolean) => { unsavedRef.current = unsaved; }, []);

  const guard = useCallback((action: () => void) => {
    if (!unsavedRef.current) { action(); return; }
    confirmDiscard(DISCARD_AUTOMATION_QUESTION, () => {
      unsavedRef.current = false;
      action();
    });
  }, [confirmDiscard]);

  useEffect(() => {
    // Captured on the document, so the question comes before the router follows the link.
    const onClick = (event: MouseEvent) => {
      if (!unsavedRef.current || keyRef.current === null || event.defaultPrevented || !isPlainClick(event)) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const route = routeOfAnchor(anchor);
      if (route === null || editorKeyForRoute(route) === keyRef.current) return;
      event.preventDefault();
      guard(() => navigate(route));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [guard, navigate]);

  return { setUnsaved, guard, dialog };
}
