import { dashboardPathFromDeepLink } from '../../apps/desktop/src/security';

/** Holds an accepted dashboard route until the shared hash router can observe it. */
export class DesktopDeepLinkNavigation {
  private dashboardReady = false;
  private readonly pendingPaths: string[] = [];

  constructor(private readonly navigate: (path: string) => void) {}

  receiveWithState(value: string): { path: string; state: 'queued' | 'navigated' } | null {
    const path = dashboardPathFromDeepLink(value);
    if (!path) return null;
    if (this.dashboardReady) this.navigate(path);
    else this.pendingPaths.push(path);
    return { path, state: this.dashboardReady ? 'navigated' : 'queued' };
  }

  receive(value: string): boolean {
    return this.receiveWithState(value) !== null;
  }

  setDashboardReady(): void {
    this.dashboardReady = true;
    this.pendingPaths.splice(0).forEach(path => this.navigate(path));
  }

  setDashboardUnavailable(): void {
    this.dashboardReady = false;
  }
}
