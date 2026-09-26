import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopStyles = readFileSync(resolve(process.cwd(), 'src/desktop/desktop.css'), 'utf8');

const ruleFor = (selector: string): string => {
  const start = desktopStyles.indexOf(`\n${selector} {`);
  if (start < 0) return '';
  const bodyStart = desktopStyles.indexOf('{', start) + 1;
  const end = desktopStyles.indexOf('}', bodyStart);
  return desktopStyles.slice(bodyStart, end);
};

const zIndexFor = (selector: string): number => {
  const match = ruleFor(selector).match(/z-index:\s*(\d+)/);
  if (!match) throw new Error(`Missing z-index for ${selector}`);
  return Number(match[1]);
};

describe('desktop window chrome styles', () => {
  it('uses the Electron overlay safe rectangle with an exact Linux control fallback', () => {
    expect(ruleFor('.desktop-entry-drag-region')).toContain('left: env(titlebar-area-x, 0px)');
    expect(ruleFor('.desktop-entry-drag-region')).toContain('width: env(titlebar-area-width, 100%)');
    expect(ruleFor('.desktop-connected-drag-region')).toContain('left: env(titlebar-area-x, 0px)');
    expect(ruleFor('.desktop-connected-drag-region')).toContain('width: env(titlebar-area-width, 100%)');
    expect(desktopStyles).toContain('env(titlebar-area-height, 0px)');
    expect(desktopStyles).toContain('width: calc(100% - var(--desktop-window-controls-end-inset))');
  });

  it('makes the sidebar strip and compact toolbar draggable while keeping every interactive control no-drag', () => {
    const chromeRule = ruleFor('.desktop-app .desktop-content-toolbar');
    expect(chromeRule).toContain('height: var(--desktop-titlebar-height)');
    expect(chromeRule).toContain('-webkit-app-region: drag');
    expect(ruleFor('.desktop-app .desktop-sidebar-drag-region')).toContain('-webkit-app-region: drag');
    expect(desktopStyles).toMatch(/\.desktop-app \.desktop-sidebar-header :is\([^}]+\)\s*\{\s*-webkit-app-region: no-drag;/);
    expect(desktopStyles).toMatch(/\.desktop-app \.desktop-content-toolbar :is\([^}]+\)\s*\{\s*-webkit-app-region: no-drag;/);
  });

  it('reserves the native controls at the toolbar end and traffic-light clearance above the workspace selector', () => {
    expect(desktopStyles).toContain(
      '.desktop-app .desktop-content-toolbar {\n  padding-right: calc(var(--desktop-window-controls-end-inset) + var(--desktop-window-controls-gap));',
    );
    const sidebarDragRule = ruleFor('.desktop-app .desktop-sidebar-drag-region');
    expect(sidebarDragRule).toContain('flex: none');
    expect(sidebarDragRule).toContain(
      'height: max(40px, var(--desktop-titlebar-height), env(titlebar-area-height, 0px))',
    );
    expect(ruleFor('.desktop-app.desktop-platform-macos')).toContain('--desktop-titlebar-height: 44px');
    expect(ruleFor('.desktop-instance-selector-button')).toContain('-webkit-app-region: no-drag');
    expect(ruleFor('.desktop-window-controls')).toContain('-webkit-app-region: no-drag');
    expect(ruleFor('.desktop-window-controls')).toContain('height: var(--desktop-titlebar-height)');
  });

  it('keeps Linux controls and their hit targets flush with the top-right window edge', () => {
    const controlsRule = ruleFor('.desktop-window-controls');
    expect(controlsRule).toContain('top: 0');
    expect(controlsRule).toContain('right: 0');
    expect(controlsRule).toContain('margin: 0');
    expect(controlsRule).toContain('padding: 0');
    expect(desktopStyles).toContain('padding: 0 0 var(--desktop-frame-inset) var(--desktop-frame-inset)');
    expect(desktopStyles).toContain('--desktop-window-controls-gap: 1.5rem');
    const dividerRule = ruleFor('.desktop-app.desktop-platform-linux .desktop-content-toolbar::after');
    expect(dividerRule).toContain('right: var(--desktop-window-controls-end-inset)');
    expect(dividerRule).toContain('height: 1.5rem');
    expect(dividerRule).toContain('border-left: 1px solid #e2e8f0');
  });

  it('uses subtle eight-pixel scrollbars throughout the desktop surface', () => {
    expect(desktopStyles).toMatch(/::-webkit-scrollbar[^}]+width: 8px;/s);
    expect(desktopStyles).toMatch(/::-webkit-scrollbar-track[^}]+background: transparent;/s);
    expect(desktopStyles).toMatch(/::-webkit-scrollbar-thumb[^}]+border-radius: 4px;\s+background: #cbd5e1;/s);
  });

  it('keeps Linux window controls above application modal backdrops', () => {
    expect(zIndexFor('.desktop-window-controls')).toBeGreaterThan(zIndexFor('.desktop-modal-backdrop'));
  });
});
