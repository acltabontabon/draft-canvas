import { expect, test } from '@playwright/test';
import { cameraAtRest, clickEdge, newCanvas } from './canvas';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`architecture labels edit where they are drawn (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await newCanvas(page, 'Shape label positions');
    const ids = await page.evaluate(async () => {
      const { createNode } = await import('/src/document/factory.ts');
      const { useEditorStore } = await import('/src/store/editorStore.ts');
      const variants = [
        { type: 'service' as const, serviceKind: 'gateway' as const },
        { type: 'component' as const, componentKind: 'adapter' as const },
        { type: 'database' as const, databaseKind: 'sql' as const },
        { type: 'queue' as const, queueKind: 'topic' as const },
        { type: 'actor' as const, actorKind: 'device' as const },
      ];
      const nodes = variants.map((variant, i) => createNode({ ...variant, x: 120 + (i % 3) * 260, y: 100 + Math.floor(i / 3) * 220, text: 'Orders', height: 120 }));
      const editor = useEditorStore.getState();
      editor.setDocument({ ...editor.document, nodes }, { resetHistory: true });
      return nodes.map((node) => node.id);
    });
    await cameraAtRest(page);
    for (const id of ids) {
      const node = page.locator(`.react-flow__node[data-id="${id}"]`);
      await node.dblclick();
      const field = node.locator('textarea');
      await expect(field).toBeFocused();
      const geometry = await page.evaluate(async (id) => {
        const { useEditorStore } = await import('/src/store/editorStore.ts');
        const { describeNode, describeContext } = await import('/src/nodes/describe.ts');
        const { LIGHT } = await import('/src/render/theme/tokens.ts');
        const node = useEditorStore.getState().document.nodes.find((node: { id: string }) => node.id === id)!;
        const label = describeNode(node, describeContext(LIGHT)).shapes.find((shape) => shape.t === 'text' && shape.role === 'label');
        if (label?.t !== 'text') throw new Error('Missing label');
        const field = document.querySelector<HTMLTextAreaElement>(`.react-flow__node[data-id="${id}"] textarea`)!;
        return { top: Number.parseFloat(field.style.top), y: label.y, width: field.clientWidth, availableWidth: label.labelWidth };
      }, id);
      expect(geometry.top).toBeCloseTo(geometry.y);
      expect(geometry.width).toBeCloseTo(geometry.availableWidth!, 0);
      await field.fill('Renamed orders');
      await field.press('Enter');
      await expect(field).toHaveCount(0);
      await expect(node).toContainText(/Renamed\s*orders/);
    }
  });
}

test('Shift-clicking a connector preserves a multiple-shape selection', async ({ page }) => {
  await newCanvas(page, 'Mixed selection');
  await page.evaluate(async () => {
    const { createNode, createEdge } = await import('/src/document/factory.ts');
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const nodes = [0, 1, 2].map((i) => createNode({ id: `shape-${i}`, type: 'service', x: 100 + i * 280, y: 200, text: `Service ${i}` }));
    const edges = [createEdge({ id: 'first', source: 'shape-0', target: 'shape-1' }), createEdge({ id: 'second', source: 'shape-1', target: 'shape-2' })];
    const editor = useEditorStore.getState();
    editor.setDocument({ ...editor.document, nodes, edges }, { resetHistory: true });
    editor.setSelection({ nodes: ['shape-0', 'shape-1'], edges: ['first'] });
  });
  await cameraAtRest(page);
  await page.keyboard.down('Shift');
  await clickEdge(page, page.locator('.react-flow__edge[data-id="second"] .dc-edge-line'));
  await page.keyboard.up('Shift');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(2);
  await page.keyboard.down('Shift');
  await clickEdge(page, page.locator('.react-flow__edge[data-id="second"] .dc-edge-line'));
  await clickEdge(page, page.locator('.react-flow__edge[data-id="first"] .dc-edge-line'));
  await page.keyboard.up('Shift');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(0);
  // Select in reverse document order: an acknowledgement must preserve both choices.
  await page.keyboard.down('Shift');
  await clickEdge(page, page.locator('.react-flow__edge[data-id="second"] .dc-edge-line'));
  await clickEdge(page, page.locator('.react-flow__edge[data-id="first"] .dc-edge-line'));
  await page.keyboard.up('Shift');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(2);
});

test('tagged notes retain a body line when resized to their minimum', async ({ page }) => {
  await newCanvas(page, 'Small warning');
  const floor = await page.evaluate(async () => {
    const { createNode } = await import('/src/document/factory.ts');
    const { noteLayout } = await import('/src/nodes/describe.ts');
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const node = createNode({ id: 'warning', type: 'note', noteKind: 'warning', x: 400, y: 180, width: 240, height: 160, text: 'Review this' });
    const geo = noteLayout(node);
    const editor = useEditorStore.getState();
    editor.setDocument({ ...editor.document, nodes: [node] }, { resetHistory: true });
    editor.setSelection({ nodes: [node.id], edges: [] });
    return Math.ceil(geo.top + geo.lineHeight + geo.bottom);
  });
  await cameraAtRest(page);
  const corner = await page.locator('.dc-resize-handle.bottom.right').boundingBox();
  expect(corner).not.toBeNull();
  await page.mouse.move(corner!.x + corner!.width / 2, corner!.y + corner!.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner!.x - 200, corner!.y - 140, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    return useEditorStore.getState().document.nodes[0].height;
  })).toBe(floor);
  const node = page.locator('.dc-node');
  const body = node.locator('svg text').last();
  const box = (await node.boundingBox())!;
  const text = (await body.boundingBox())!;
  expect(text.y + text.height).toBeLessThan(box.y + box.height);
});
