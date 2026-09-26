import { isAbsolute, join, resolve } from 'node:path';
import type { NativeImage, NotificationConstructorOptions } from 'electron';

export const DESKTOP_ICON_FILE = 'propr-desktop.png';
export const TRAY_ICON_FILE = 'propr-tray.png';
export const DESKTOP_ICON_SIZE = 512;

interface NativeImageFactory {
  createFromPath: (path: string) => NativeImage;
}

export interface DesktopWindowIcon {
  image: NativeImage;
  path: string;
  size: { width: number; height: number };
}

export const createDesktopNotificationOptions = ({
  platform,
  title,
  body,
  iconPath,
}: {
  platform: NodeJS.Platform;
  title: string;
  body: string;
  iconPath?: string;
}): NotificationConstructorOptions => {
  if (platform !== 'linux') return { title, body };
  if (!iconPath || !isAbsolute(iconPath)) {
    throw new Error('Linux desktop notifications require an absolute ProPR application icon path');
  }
  return { title, body, icon: iconPath };
};

export const resolveLinuxDesktopIconPath = ({
  isPackaged,
  mainBundleDirectory,
  resourcesPath,
}: {
  isPackaged: boolean;
  mainBundleDirectory: string;
  resourcesPath: string;
}): string => isPackaged
  ? join(resourcesPath, DESKTOP_ICON_FILE)
  : resolve(mainBundleDirectory, '../../assets/icons', DESKTOP_ICON_FILE);

export const resolveDesktopTrayIconPath = ({
  isPackaged,
  mainBundleDirectory,
  resourcesPath,
}: {
  isPackaged: boolean;
  mainBundleDirectory: string;
  resourcesPath: string;
}): string => isPackaged
  ? join(resourcesPath, TRAY_ICON_FILE)
  : resolve(mainBundleDirectory, '../../assets/icons', TRAY_ICON_FILE);

export const loadDesktopWindowIcon = ({
  platform,
  isPackaged,
  mainBundleDirectory,
  resourcesPath,
  nativeImage,
}: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  mainBundleDirectory: string;
  resourcesPath: string;
  nativeImage: NativeImageFactory;
}): DesktopWindowIcon | undefined => {
  if (platform !== 'linux') return undefined;
  const path = resolveLinuxDesktopIconPath({ isPackaged, mainBundleDirectory, resourcesPath });
  const image = nativeImage.createFromPath(path);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== DESKTOP_ICON_SIZE || size.height !== DESKTOP_ICON_SIZE) {
    throw new Error(`ProPR desktop window icon must load as ${DESKTOP_ICON_SIZE}x${DESKTOP_ICON_SIZE}`);
  }
  return { image, path, size };
};
