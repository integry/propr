const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { join } = require('node:path');

app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{
  scheme: 'propr-readiness-fixture',
  privileges: { standard: true, secure: true },
}]);

app.whenReady().then(async () => {
  protocol.handle('propr-readiness-fixture', () => new Response(
    '<main>renderer readiness fixture</main>',
    { headers: { 'content-type': 'text/html; charset=UTF-8' } },
  ));
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'electron-frame-semantics-preload.cjs'),
      sandbox: true,
    },
  });
  const initialFrame = window.webContents.mainFrame;
  const initialDocumentId = `${initialFrame.processId}:${initialFrame.frameToken}`;
  let navigationStarted;
  let navigationCommitted;
  let initialNavigationCompleted = false;
  window.webContents.on('did-start-navigation', (details, deprecatedUrl) => {
    const frame = window.webContents.mainFrame;
    navigationStarted = {
      detailsIsFirst: typeof details === 'object' && details !== null,
      deprecatedUrlIsSecond: typeof deprecatedUrl === 'string',
      isMainFrame: details.isMainFrame,
      isSameDocument: details.isSameDocument,
      detailsFrameMatchesGetter: details.frame === frame,
      initialFrameMatchesGetter: initialFrame === frame,
      initialDocumentIdMatches: initialDocumentId === `${frame.processId}:${frame.frameToken}`,
    };
  });
  window.webContents.on('did-navigate', () => {
    const firstGetter = window.webContents.mainFrame;
    const secondGetter = window.webContents.mainFrame;
    navigationCommitted = {
      firstGetterMatchesSecondGetter: firstGetter === secondGetter,
      initialFrameMatchesGetter: initialFrame === firstGetter,
      initialDocumentIdMatches: initialDocumentId === `${firstGetter.processId}:${firstGetter.frameToken}`,
    };
  });
  const readinessReport = new Promise(resolve => {
    ipcMain.handle('ready', event => {
      const firstGetter = event.sender.mainFrame;
      const secondGetter = event.sender.mainFrame;
      resolve({
        navigationStarted,
        navigationCommitted,
        readiness: {
          senderFrameMatchesFirstGetter: event.senderFrame === firstGetter,
          firstGetterMatchesSecondGetter: firstGetter === secondGetter,
          initialFrameMatchesGetter: initialFrame === firstGetter,
          initialDocumentIdMatches: initialDocumentId === `${firstGetter.processId}:${firstGetter.frameToken}`,
        },
      });
    });
  });
  await window.loadURL('propr-readiness-fixture://app/renderer.html');
  initialNavigationCompleted = true;
  const report = await readinessReport;
  const webContents = window.webContents;
  window.once('closed', () => {
    let getterError;
    try {
      void window.webContents;
    } catch (error) {
      getterError = {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    process.stdout.write(`${JSON.stringify({
      ...report,
      teardown: {
        initialNavigationCompleted,
        windowDestroyed: window.isDestroyed(),
        cachedWebContentsAccessible: typeof webContents.isDestroyed() === 'boolean',
        getterError,
      },
    })}\n`);
    app.quit();
  });
  window.destroy();
}).catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
