import { useEffect, useState } from 'react';
import { getTaskExtensionsPreview, type TaskExtensionsPreview } from '../../api/taskSubmissions';

/**
 * The library items a New Task submission would use, fetched for the chosen
 * repository and agent. Errors and unqualified runtimes show nothing: the
 * worker resolves the library again at launch either way.
 */
export function useTaskExtensionsPreview(repository: string, agentAlias: string | undefined, model: string | undefined, enabled: boolean): TaskExtensionsPreview | undefined {
  const [preview, setPreview] = useState<TaskExtensionsPreview>();
  useEffect(() => {
    setPreview(undefined);
    if (!enabled || !repository) return;
    const controller = new AbortController();
    void getTaskExtensionsPreview(repository, agentAlias, model, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [repository, agentAlias, model, enabled]);
  return preview;
}

const previewHasWriteServer = (preview?: TaskExtensionsPreview) => Boolean(preview?.servers.some(server => server.capability === 'write'));

/** The submission's extension fields; the write opt-in only while a write server would apply. */
export function taskExtensionChoices(disableExtensions: boolean, allowWrite: boolean, preview?: TaskExtensionsPreview): { disableExtensions?: true; extensionAllowWrite?: true } {
  if (disableExtensions) return { disableExtensions: true };
  return allowWrite && previewHasWriteServer(preview) ? { extensionAllowWrite: true } : {};
}

/** New Task extension state: the preview for the chosen routing, the write opt-in and the disable switch. */
export function useTaskExtensionChoices(routing: { repository: string; agentAlias: string; model?: string; ready: boolean; demo: boolean; invalidRouting: boolean }) {
  const [extensionAllowWrite, setExtensionAllowWrite] = useState(false);
  const [disableExtensions, setDisableExtensions] = useState(false);
  const enabled = routing.ready && !routing.demo && !routing.invalidRouting;
  const extensionsPreview = useTaskExtensionsPreview(routing.repository, routing.agentAlias || undefined, routing.model, enabled);
  return {
    extensionsPreview, extensionAllowWrite, setExtensionAllowWrite, disableExtensions, setDisableExtensions,
    extensionChoices: taskExtensionChoices(disableExtensions, extensionAllowWrite, extensionsPreview),
  };
}
