import { dashboardPathFromDeepLink } from '../../apps/desktop/src/security';

/** Holds an accepted dashboard route until the shared hash router can observe it. */
export class DesktopDeepLinkNavigation {
  private dashboardReady = false;
  private readonly pendingPaths: string[] = [];

  constructor(private readonly navigate: (path: string) => void) {}

  receive(value: string): boolean {
    const path = dashboardPathFromDeepLink(value);
    if (!path) return false;
    if (this.dashboardReady) this.navigate(path);
    else this.pendingPaths.push(path);
    return true;
  }

  setDashboardReady(): void {
    this.dashboardReady = true;
    this.pendingPaths.splice(0).forEach(path => this.navigate(path));
  }

  setDashboardUnavailable(): void {
    this.dashboardReady = false;
  }
}
