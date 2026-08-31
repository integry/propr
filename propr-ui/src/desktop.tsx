import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DesktopDeepLinkNavigation } from './desktop-deep-link';
import './index.css';

export const DesktopApp = () => {
  const [deepLinkNavigation] = useState(() => new DesktopDeepLinkNavigation(path => {
    window.location.hash = path;
  }));

  useEffect(() => {
    const bridge = window.proprDesktop;
    if (!bridge) return;
    deepLinkNavigation.setDashboardReady();
    const unsubscribe = bridge.app.onDeepLink(value => {
      deepLinkNavigation.receive(value);
    });
    return () => {
      unsubscribe();
      deepLinkNavigation.setDashboardUnavailable();
    };
  }, [deepLinkNavigation]);

  return <App />;
};

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing in renderer.html');

if (location.hash === '#packaged-transport-smoke') {
  void import('./desktop/packagedTransportSmoke').then(({ installPackagedTransportSmokeHarness }) => {
    installPackagedTransportSmokeHarness();
  });
}

createRoot(container).render(<StrictMode><DesktopApp /></StrictMode>);
