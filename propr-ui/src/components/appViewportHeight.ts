import { isDesktopRuntime } from '../config/runtimeMode';

/**
 * Desktop mounts the app inside `.desktop-app`, whose box excludes the Linux
 * frame allowance. `100vh` would overflow it by that allowance, and a focus or
 * scrollIntoView could then scroll the toolbar away from the window controls.
 */
export const appViewportHeight = (): string => (isDesktopRuntime() ? 'h-full' : 'h-screen');
