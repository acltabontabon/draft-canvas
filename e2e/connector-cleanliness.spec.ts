import { PERSONALITY_PRESETS } from '../src/theme/usePersonality';
import { expect, test } from '@playwright/test';
import { serializeDocument } from '../src/export/project';
import { connectorStyleDocument } from '../tests/fixtures/connectors/checkout';
import { cameraAtRest } from './canvas';

for (const colorScheme of ['light', 'dark'] as const) {
  for (const preset of PERSONALITY_PRESETS) {
  test(`${preset} connectors remain clean and match their export in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.addInitScript(value => localStorage.setItem('draft-canvas.personality', value), preset);
    await page.goto('/');
    const fixture = connectorStyleDocument();
    await page.setInputFiles('input[type="file"]', { name: 'checkout.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(serializeDocument(fixture)) });
    await expect(page.locator('.dc-editor')).toBeVisible();
    await cameraAtRest(page);
    await page.mouse.move(10, 100);
    const parity = await page.evaluate(async ({ scheme, preset }) => {
      // Browser URLs use Vite's module graph, independently of the test runner's module instances.
      // oxlint-disable-next-line typescript/no-explicit-any
      const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
      const { useEditorStore } = await load('/src/store/editorStore.ts');
      const { connectorRoutes } = await load('/src/edges/connectorRoutes.ts');
      const { describeEdge } = await load('/src/edges/describe.ts');
      const { StaticTextMeasurer } = await load('/src/render/text/measure.ts');
      const { THEMES } = await load('/src/render/theme/tokens.ts');
      const { stepPolyline } = await load('/src/edges/waypoints.ts');
      const doc = useEditorStore.getState().document;
      return doc.edges.map((edge: { id: string }) => {
        const routes = connectorRoutes(edge, doc, 'transient');
        const described = describeEdge(edge, new Map(doc.nodes.map((n: { id: string }) => [n.id, n])), { routes, preset, theme: THEMES[scheme], measurer: new StaticTextMeasurer(), showSequence: false });
        const line = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${edge.id}"] .dc-edge-line`)!;
        const response = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${edge.id}"] .dc-edge-response-line`);
        return { id: edge.id, drawn: line.getAttribute('d'), exported: described.line[0].d, width: Number(getComputedStyle(line).strokeWidth.replace('px', '')), exportedWidth: described.line[0].stroke.width, reply: response?.getAttribute('d') ?? null, exportedReply: described.responseLine?.[0].d ?? null, ys: stepPolyline(routes.request.d).map((p: { y: number }) => p.y) };
      });
    }, { scheme: colorScheme, preset });
    for (const edge of parity) {
      expect(edge.drawn, edge.id).toBe(edge.exported);
      expect(edge.width, edge.id).toBe(edge.exportedWidth);
      expect(edge.reply, edge.id).toBe(edge.exportedReply);
    }
    expect(new Set(parity.find((e: { id: string; ys: number[] }) => e.id === 'record')!.ys).size).toBe(1);
    const overlay = page.locator('[data-edge-overlay="authorize"]');
    const request = await overlay.locator('.dc-edge-label').boundingBox();
    const reply = await overlay.locator('.dc-edge-response-label').boundingBox();
    expect(request).not.toBeNull();
    expect(reply).not.toBeNull();
    expect(reply!.x + reply!.width).toBeLessThan(request!.x);
  });
  }
}


test('hover traces once, is removed on leave and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', { name: 'checkout.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(serializeDocument(connectorStyleDocument())) });
  await expect(page.locator('.dc-editor')).toBeVisible();
  await cameraAtRest(page);
  expect(await page.locator('.dc-edge-trace').count()).toBe(0);
  const edge = page.locator('.react-flow__edge[data-id="authorize"]');
  const point = await edge.locator('.dc-edge-hit').first().evaluate((element) => {
    const path = element as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() * 0.45).matrixTransform(path.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(point.x, point.y);
  await expect(edge.locator('.dc-edge-trace')).toHaveCount(2);
  const animation = await edge.locator('.dc-edge-trace').first().evaluate((path) => {
    const animation = path.getAnimations()[0]!;
    const timing = animation.effect!.getTiming();
    animation.finish();
    return { iterations: timing.iterations, opacity: getComputedStyle(path).opacity };
  });
  expect(animation).toEqual({ iterations: 1, opacity: '0' });
  await page.mouse.move(10, 100);
  await expect(page.locator('.dc-edge-trace')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(point.x, point.y);
  await expect(edge.locator('.dc-edge-trace').first()).toBeHidden();
  expect(await edge.locator('.dc-edge-trace').first().evaluate((path) => path.getAnimations().length)).toBe(0);
});


test('global drawing style controls all arrows without per-arrow appearance controls or document edits', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', { name: 'checkout.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(serializeDocument(connectorStyleDocument())) });
  await expect(page.locator('.dc-editor')).toBeVisible();
  await cameraAtRest(page);
  const snapshot = () => page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    return { document: JSON.stringify(state.document), history: state.history.past.length };
  });
  const before = await snapshot();
  const cleanPaths = await page.locator('.dc-edge-line').evaluateAll(paths => paths.map(p => p.getAttribute('d')));
  for (const style of ['Sketch', 'Draft', 'Clean']) {
    await page.getByRole('button', { name: 'Canvas settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('radio', { name: new RegExp(`^${style}`) }).check();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator(':root')).toHaveAttribute('data-personality', style.toLowerCase());
    const paths = await page.locator('.dc-edge-line').evaluateAll(paths => paths.map(p => p.getAttribute('d')));
    if (style === 'Clean') expect(paths).toEqual(cleanPaths);
    else for (let i = 0; i < paths.length; i += 1) expect(paths[i]).not.toBe(cleanPaths[i]);
    await expect(page.locator('.dc-edge-retrace')).toHaveCount(style === 'Sketch' ? 6 : 0);
    expect(await snapshot()).toEqual(before);
  }
  const point = await page.locator('.react-flow__edge[data-id="authorize"] .dc-edge-hit').first().evaluate(element => {
    const path = element as SVGPathElement;
    const at = path.getPointAtLength(path.getTotalLength() * 0.7).matrixTransform(path.getScreenCTM()!);
    return { x: at.x, y: at.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole('toolbar', { name: 'Connector options' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Arrow appearance:/ })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Connector shape' })).toBeVisible();
  await page.getByRole('button', { name: 'Canvas settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: /^Sketch/ }).check();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator(':root')).toHaveAttribute('data-personality', 'sketch');
  await expect(page.locator('.dc-edge-retrace')).toHaveCount(6);
});

test('global Sketch visibly changes the full stroke and retrace of a straight connector', async ({ page }) => {
  const fixture = connectorStyleDocument();
  await page.addInitScript(() => localStorage.setItem('draft-canvas.personality', 'sketch'));
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', { name: 'pencil.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(serializeDocument(fixture)) });
  await expect(page.locator('.dc-editor')).toBeVisible();
  await cameraAtRest(page);
  const edge = page.locator('.react-flow__edge[data-id="record"]');
  const strokes = await edge.locator('.dc-edge-line, .dc-edge-retrace').evaluateAll(elements => elements.map(element => {
    const path = element as SVGPathElement;
    const length = path.getTotalLength();
    const points = Array.from({ length: 101 }, (_, i) => path.getPointAtLength(i * length / 100));
    return { d: path.getAttribute('d'), height: Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) };
  }));
  expect(strokes).toHaveLength(2);
  expect(strokes[0]!.height).toBeGreaterThan(1.8);
  expect(strokes[1]!.height).toBeGreaterThan(1.8);
  expect(strokes[0]!.d).not.toBe(strokes[1]!.d);
});
