import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';
import { serveStarterGallery } from './gallery';

/** The open file's own style, as the store holds it. */
const documentStyle = (page: Page) =>
  page.evaluate(async () => {
    // Browser URLs use Vite's module graph, independently of the test runner's module instances.
    // oxlint-disable-next-line typescript/no-explicit-any
    const { fileOf, useEditorStore } = (await import(/* @vite-ignore */ '/src/store/editorStore.ts' as string)) as any;
    return fileOf(useEditorStore.getState()).style ?? null;
  });

/** How heavy the first shape's outline is drawn on the canvas. */
const outlineWidth = (page: Page) =>
  page
    .locator('.react-flow__node [stroke-width]')
    .first()
    .evaluate((element) => Number(element.getAttribute('stroke-width')));

async function openAppearance(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
  await page.keyboard.type('Appearance');
  await expect(page.getByRole('option', { selected: true })).toContainText('Appearance');
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('tab', { name: 'Appearance', exact: true })).toHaveAttribute('aria-selected', 'true');
  return settings;
}

test('a style is made in Settings, kept on this device, and the open diagram follows it', async ({ page }) => {
  await newCanvas(page, 'My style');
  await create(page, 'Service', { x: 420, y: 320 });
  await page.keyboard.press('Escape');

  // A new diagram starts with a copy of the style in use: the built-in Clean.
  expect(await documentStyle(page)).toMatchObject({ v: 1, hand: { base: 'clean' } });
  const regular = await outlineWidth(page);

  let settings = await openAppearance(page);
  const mine = settings.getByRole('group', { name: 'My style' });
  await expect(mine.getByRole('radio', { name: /^Clean/ })).toBeChecked();
  await expect(settings.getByText(/following your changes here/)).toBeVisible();

  // The first change makes it a style of the person's own. The picture of it follows at once, and
  // so does the diagram on the canvas, which was drawn in that style.
  const stage = settings.locator('.dc-prefs-stage .dc-style-preview');
  const before = await stage.innerHTML();
  await settings.getByRole('radiogroup', { name: 'Line weight', exact: true }).getByText('Bold', { exact: true }).click();
  await expect(mine.getByRole('radio', { name: /^My style/ })).toBeChecked();
  await expect.poll(() => stage.innerHTML()).not.toBe(before);
  await expect.poll(() => outlineWidth(page)).toBeGreaterThan(regular);
  await settings.getByRole('radiogroup', { name: 'Corners', exact: true }).getByText('Round', { exact: true }).click();
  await expect.poll(async () => (await documentStyle(page))?.general).toEqual({ weight: 'bold', corners: 'round' });
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  // Everything changed in that visit is one step, which undo takes back.
  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => outlineWidth(page)).toBe(regular);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => outlineWidth(page)).toBeGreaterThan(regular);

  // The style is this device's: still there, and still the one in use, after a reload.
  await page.reload();
  await expect(page.locator('.dc-editor')).toBeVisible();
  settings = await openAppearance(page);
  await expect(settings.getByRole('group', { name: 'My style' }).getByRole('radio', { name: /^My style/ })).toBeChecked();
  await expect(settings.getByText(/following your changes here/)).toBeVisible();
});

test('a diagram with a look of its own keeps it until asked', async ({ page }) => {
  await newCanvas(page, 'Its own look');
  await create(page, 'Service', { x: 420, y: 320 });
  await page.keyboard.press('Escape');
  // As it would arrive from someone else: drawn in a style that is not this device's.
  await page.evaluate(async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const { useEditorStore } = (await import(/* @vite-ignore */ '/src/store/editorStore.ts' as string)) as any;
    useEditorStore.getState().setDocumentStyle({ v: 1, name: 'Theirs', hand: { base: 'sketch' }, general: { weight: 'fine' } });
  });
  const theirs = await outlineWidth(page);

  const settings = await openAppearance(page);
  await expect(settings.getByText(/Your changes here do not touch it/)).toBeVisible();
  await settings.getByRole('radiogroup', { name: 'Line weight', exact: true }).getByText('Bold', { exact: true }).click();
  expect(await documentStyle(page)).toMatchObject({ name: 'Theirs', general: { weight: 'fine' } });
  expect(await outlineWidth(page)).toBe(theirs);

  await settings.getByRole('button', { name: 'Use my style', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Use my style', exact: true })).toBeDisabled();
  expect(await documentStyle(page)).toMatchObject({ name: 'My style', general: { weight: 'bold' } });
  await expect.poll(() => outlineWidth(page)).toBeGreaterThan(theirs);
});

test('a style’s colours dress the canvas and leave the app around it alone', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await newCanvas(page, 'Colours');
  await create(page, 'Service', { x: 420, y: 320 });
  await page.keyboard.press('Escape');
  const colours = () =>
    page.evaluate(() => ({
      canvas: getComputedStyle(document.querySelector('.dc-canvas')!).getPropertyValue('--dc-canvas').trim(),
      app: getComputedStyle(document.documentElement).getPropertyValue('--dc-canvas').trim(),
    }));
  const plain = await colours();
  expect(plain.canvas).toBe(plain.app);

  const settings = await openAppearance(page);
  await settings.locator('.dc-prefs-palette', { hasText: 'Paper' }).click();
  await expect(settings.getByRole('radio', { name: /^Paper:/ })).toBeChecked();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  const dressed = await colours();
  expect(dressed.app).toBe(plain.app);
  expect(dressed.canvas).not.toBe(plain.canvas);
});

test('a shape is drawn with a picture of the person’s own, and stays the shape it was', async ({ page }) => {
  await newCanvas(page, 'Own drawing');
  await create(page, 'Data Store', { x: 420, y: 320 });
  await page.keyboard.press('Escape');
  const node = page.locator('.react-flow__node').first();
  const box = () => node.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [Math.round(rect.width), Math.round(rect.height)];
  });
  const before = await box();
  const builtIn = await node.locator('path, ellipse, rect').count();
  const name = (await node.textContent()) ?? '';
  expect(name).not.toBe('');

  const settings = await openAppearance(page);
  await settings.locator('.dc-prefs-shape', { hasText: 'Data store' }).click();
  await settings.getByRole('button', { name: 'Paste SVG', exact: true }).click();
  await settings.getByRole('textbox', { name: 'SVG code' }).fill(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="window.__pwned = true"><script>window.__pwned = true</script>' +
      '<path d="M25 10H75Q92 50 75 90H25Q8 50 25 10Z" fill="#f4e2c0" stroke="#5b3413" stroke-width="5"/>' +
      '<path d="M19 30Q50 36 81 30" fill="none" stroke="#5b3413" stroke-width="6"/><image href="https://example.test/x.png" width="5" height="5"/></svg>',
  );
  await settings.getByRole('button', { name: 'Use this', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('left out');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  // Two paths where the cylinder was; the same box; the same name.
  await expect.poll(() => node.locator('path').count()).toBe(2);
  expect(await node.locator('ellipse, rect, image, script').count()).toBe(0);
  expect(builtIn).not.toBe(2);
  expect(await box()).toEqual(before);
  await expect(node).toHaveText(name);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  expect(JSON.stringify(await documentStyle(page))).not.toMatch(/script|onload|https?:|image/);
});

test('a shape saved as my default is how the next one of its type starts', async ({ page }) => {
  await newCanvas(page, 'Defaults');
  await create(page, 'Service', { x: 300, y: 300 });
  await page.keyboard.press('Escape');
  const nodes = () =>
    page.evaluate(async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const { useEditorStore } = (await import(/* @vite-ignore */ '/src/store/editorStore.ts' as string)) as any;
      return useEditorStore.getState().document.nodes.map((node: { accent?: string; serviceKind?: string }) => [node.accent ?? null, node.serviceKind ?? null]);
    });
  // Made the way the inspector makes it: a blue gateway.
  await page.evaluate(async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const { useEditorStore } = (await import(/* @vite-ignore */ '/src/store/editorStore.ts' as string)) as any;
    const state = useEditorStore.getState();
    state.updateNodeById(state.document.nodes[0].id, { accent: 'blue', serviceKind: 'gateway' }, 'Recolour');
  });

  await page.locator('.react-flow__node').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save as my default Service' }).click();
  await expect(page.getByText('New Service shapes will start like this one.')).toBeVisible();

  await create(page, 'Service', { x: 620, y: 300 });
  await page.keyboard.press('Escape');
  expect(await nodes()).toEqual([
    ['blue', 'gateway'],
    ['blue', 'gateway'],
  ]);

  // And the way back, from the same menu.
  await page.locator('.react-flow__node').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset my default Service' }).click();
  await create(page, 'Service', { x: 460, y: 480 });
  await page.keyboard.press('Escape');
  expect((await nodes())[2]).toEqual([null, 'generic']);
});

test('a style pack is loaded from the gallery on request, added, and draws the open diagram', async ({ page }) => {
  await serveStarterGallery(page, { enabled: false, current: true });
  await newCanvas(page, 'Packs');
  await create(page, 'Data Store', { x: 420, y: 320 });
  await page.keyboard.press('Escape');
  const node = page.locator('.react-flow__node').first();
  const box = () => node.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [Math.round(rect.width), Math.round(rect.height)];
  });
  const before = await box();
  const name = (await node.textContent()) ?? '';
  const drawing = () => node.locator('path').evaluateAll((paths) => paths.map((path) => path.getAttribute('d')).join(' '));
  const builtIn = await drawing();

  // Nothing is read from the gallery until it is asked for.
  const settings = await openAppearance(page);
  await expect(settings.locator('.dc-prefs-pack')).toHaveCount(0);
  await settings.getByRole('button', { name: 'Load style packs', exact: true }).click();
  const pack = settings.locator('.dc-prefs-pack', { hasText: 'High seas' });
  await expect(pack.locator('.dc-style-preview svg')).toBeVisible();
  expect(await settings.locator('.dc-prefs-pack').count()).toBeGreaterThanOrEqual(7);

  // Added, it is a style of the person's own and the one in use; the diagram was drawn in the style
  // in use, so it goes along.
  await pack.getByRole('button', { name: 'Add High seas to my styles', exact: true }).click();
  await expect(pack.getByRole('button', { name: 'High seas is in your styles', exact: true })).toBeDisabled();
  await expect(settings.getByRole('group', { name: 'My style' }).getByRole('radio', { name: /^High seas/ })).toBeChecked();
  await expect.poll(async () => (await documentStyle(page))?.name).toBe('High seas');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  // The barrel where the cylinder was: the same box, the same name, the pack's own canvas.
  await expect.poll(drawing).not.toBe(builtIn);
  expect(await node.locator('path').count()).toBeGreaterThan(0);
  expect(await box()).toEqual(before);
  await expect(node).toHaveText(name);
  const style = await documentStyle(page);
  expect(style.assets.length).toBeGreaterThan(0);
  expect(JSON.stringify(style)).not.toMatch(/script|https?:|<svg/);
});
