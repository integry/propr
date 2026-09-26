import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing in renderer.html');

if (location.hash === '#packaged-transport-smoke') {
  void import('./desktop/packagedTransportSmoke').then(({ installPackagedTransportSmokeHarness }) => {
    installPackagedTransportSmokeHarness();
  });
}

createRoot(container).render(<StrictMode><App /></StrictMode>);
