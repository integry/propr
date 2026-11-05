/**
 * Counts how often Desktop has cleared this renderer's profile state because
 * the identity behind the active connection was replaced: another profile or
 * endpoint, or a new credential for the same one. A renewal of the same
 * identity leaves it unchanged. It carries no credential material, only the
 * moment state held for the page must be dropped along with storage.
 */
let generation = 0;
const listeners = new Set<() => void>();

export const getRendererProfileStateGeneration = (): number => generation;

export const subscribeRendererProfileStateGeneration = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Called whenever Desktop clears the renderer's profile state, before the clear itself, so a failed clear still drops page state. */
export const markRendererProfileStateCleared = (): void => {
  generation += 1;
  listeners.forEach(listener => listener());
};
