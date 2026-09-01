import type { DesktopBridge, DesktopProfile } from '../../apps/desktop/src/shared/contract';

export const activateDesktopProfile = async (
  profiles: Pick<DesktopBridge['profiles'], 'setActive'>,
  profile: DesktopProfile,
  reload: () => void = () => window.location.reload(),
) => {
  await profiles.setActive(profile.id);
  reload();
};
