import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { applyDevelopmentRendererCsp } from './src/security';
import { resolveDesktopVersion } from './src/release-config';
import { viteFileSystemUrl } from './src/vite-file-system-url';

const rootPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };
const desktopVersion = resolveDesktopVersion(rootPackage.version);
const proprUiRoot = fileURLToPath(new URL('../../propr-ui', import.meta.url));
const rendererEntrySource = '../../propr-ui/src/desktop.tsx';
const rendererEntryDevelopmentUrl = viteFileSystemUrl(
  fileURLToPath(new URL(rendererEntrySource, import.meta.url)),
);

const transformDevelopmentRendererHtml = (html: string): string => {
  if (!html.includes(rendererEntrySource)) {
    throw new Error('renderer.html is missing the shared desktop renderer entry');
  }
  return applyDevelopmentRendererCsp(html).replace(rendererEntrySource, rendererEntryDevelopmentUrl);
};

const developmentCspPlugin: Plugin = {
  name: 'propr-desktop-development-csp',
  apply: 'serve',
  transformIndexHtml: {
    order: 'pre',
    handler: transformDevelopmentRendererHtml,
  },
};

const compiledRendererCssPlugin: Plugin = {
  name: 'propr-desktop-compiled-renderer-css',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const css = Object.values(bundle)
      .flatMap(output => output.type === 'asset' && output.fileName.endsWith('.css')
        ? [typeof output.source === 'string'
            ? output.source
            : Buffer.from(output.source).toString('utf8')]
        : [])
      .join('\n');
    if (!css) throw new Error('Desktop renderer build emitted no CSS');
    if (/@(?:tailwind|apply)\b/.test(css)) {
      throw new Error('Desktop renderer CSS still contains uncompiled Tailwind directives');
    }
    for (const selector of ['.h-5', '.space-y-5', '.bg-primary-500', '.dashboard-card']) {
      if (!css.includes(selector)) {
        throw new Error(`Desktop renderer CSS is missing representative selector ${selector}`);
      }
    }
  },
};

export default defineConfig({
  base: './',
  css: {
    postcss: proprUiRoot,
  },
  define: {
    __APP_VERSION__: JSON.stringify(desktopVersion),
    __PROPR_DESKTOP__: 'true',
  },
  plugins: [developmentCspPlugin, react(), compiledRendererCssPlugin],
  publicDir: '../../propr-ui/public',
  build: {
    sourcemap: true,
    rollupOptions: {
      input: 'renderer.html',
      output: {
        manualChunks: {
          'charts-vendor': ['recharts'],
          'markdown-vendor': ['react-markdown', 'remark-breaks', 'remark-gfm'],
          'motion-vendor': ['framer-motion'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
