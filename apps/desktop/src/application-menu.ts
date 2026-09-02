type ApplicationMenuController = {
  setApplicationMenu: (menu: null) => void;
};

export const configureApplicationMenu = (
  menu: ApplicationMenuController,
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
): void => {
  if (isPackaged && platform === 'linux') {
    menu.setApplicationMenu(null);
  }
};
