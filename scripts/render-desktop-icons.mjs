// Renders the SVGs in src-tauri/icons/src/ to PNGs with the Chromium Playwright already installs,
// so the desktop icons regenerate from source with nothing new to install:
//   node scripts/render-desktop-icons.mjs && npx tauri icon src-tauri/icons/src/app.png -o src-tauri/icons
// (`tauri icon` writes the .icns/.ico set. Its android/ and ios/ output is dropped: neither ships.)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');
const outputs = [
  { svg: 'app.svg', png: 'src/app.png', size: 1024 },
  { svg: 'tray-template.svg', png: 'tray-template.png', size: 44 },
  { svg: 'tray-color.svg', png: 'tray-color.png', size: 64 },
  { svg: 'tray-template-unsaved.svg', png: 'tray-template-unsaved.png', size: 44 },
  { svg: 'tray-color-unsaved.svg', png: 'tray-color-unsaved.png', size: 64 },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { svg, png, size } of outputs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${readFileSync(join(root, 'src', svg), 'utf8')}`,
    );
    writeFileSync(join(root, png), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  }
} finally {
  await browser.close();
}
