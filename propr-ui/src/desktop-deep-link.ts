import { dashboardPathFromDeepLink } from '../../apps/desktop/src/security';

const validProfileId = (value: string): boolean => value.length > 0 && value.length <= 128 && !/[\u0000-\u001F\u007F]/.test(value);

interface PendingNavigation {
  path: string;
  profileId: string;
}

/** Holds accepted routes while binding each one to the profile active when it arrived. */
export class DesktopDeepLinkNavigation {
  private activeProfileId: string | null = null;
  private readonly pending: PendingNavigation[] = [];

  constructor(
    private readonly navigate: (path: string) => void,
    private readonly reject: () => void = () => undefined,
  ) {}

  receive(value: string, profileId: string): boolean {
    const path = dashboardPathFromDeepLink(value);
    if (!path || !validProfileId(profileId)) {
      this.reject();
      return false;
    }
    if (this.activeProfileId === profileId) this.navigate(path);
    else if (this.activeProfileId === null) this.pending.push({ path, profileId });
    else {
      this.reject();
      return false;
    }
    return true;
  }

  setDashboardReady(profileId: string): void {
    if (!validProfileId(profileId)) {
      this.rejectPending();
      return;
    }
    this.activeProfileId = profileId;
    this.pending.splice(0).forEach(item => {
      if (item.profileId === profileId) this.navigate(item.path);
      else this.reject();
    });
  }

  setDashboardUnavailable(): void {
    this.activeProfileId = null;
  }

  rejectPending(): void {
    const rejected = this.pending.splice(0).length;
    if (rejected > 0) this.reject();
  }
}

/** One-consumer handoff between the desktop bridge and presentation experience. */
export class DesktopDeepLinkInbox {
  private listener: ((value: string) => void) | null = null;
  private readonly pending: string[] = [];

  receive(value: string): void {
    if (this.listener) this.listener(value);
    else this.pending.push(value);
  }

  subscribe(listener: (value: string) => void): () => void {
    if (this.listener) throw new Error('Desktop deep-link inbox already has a consumer');
    this.listener = listener;
    this.pending.splice(0).forEach(value => listener(value));
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
}
