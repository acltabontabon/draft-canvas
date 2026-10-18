import { expect, test, type Page } from '@playwright/test';
import { cameraAtRest, nextFrames } from './canvas';

test.use({ screenshot: 'only-on-failure' });

async function openResponse(page: Page) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'response-label.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'draft-canvas',
      version: 1,
      metadata: { id: 'response-label', title: 'Enabled response label', createdAt: 1, updatedAt: 2 },
      nodes: [
        { id: 'caller', type: 'service', x: 0, y: 0, width: 160, height: 100, z: 0, text: 'Caller' },
        { id: 'callee', type: 'service', x: 300, y: 234, width: 160, height: 100, z: 0, text: 'Callee' },
      ],
      edges: [{
        id: 'call', source: 'caller', target: 'callee', directed: true, routing: 'smoothstep',
        label: 'Request', hasResponse: true, response: 'Customer found',
        sourceAnchor: { side: 'bottom', offset: 0.5 }, targetAnchor: { side: 'left', offset: 0.5 },
      }],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { showSequence: false, grid: 'dots' },
    })),
  });
  await expect(page.locator('.dc-edge-response-label')).toHaveText('Customer found');
  await cameraAtRest(page);
}

async function moveCallee(page: Page, y: number) {
  await page.evaluate(async (y) => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    useEditorStore.getState().commitPositions(new Map([['callee', { x: 300, y }]]));
  }, y);
  await nextFrames(page);
}

test('an enabled reply label follows a one-pixel move without jumping to another leg', async ({ page }) => {
  await openResponse(page);
  const label = page.locator('.dc-edge-response-label');
  const before = (await label.boundingBox())!;
  await moveCallee(page, 235);
  const after = (await label.boundingBox())!;
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(5);
  await expect(page.locator('.dc-edge-response-line')).toHaveCount(1);
  expect(await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    return useEditorStore.getState().document.edges[0].hasResponse;
  })).toBe(true);
});

test('an enabled reply label stays paired with its request through movement, undo and reload', async ({ page }) => {
  await openResponse(page);
  const request = page.locator('.dc-edge-label');
  const response = page.locator('.dc-edge-response-label');
  const paired = async () => {
    const a = (await request.boundingBox())!;
    const b = (await response.boundingBox())!;
    expect(Math.abs((a.x + a.width / 2) - (b.x + b.width / 2))).toBeLessThan(2);
    expect(b.y).toBeGreaterThan(a.y + a.height);
  };
  for (const y of [220, 235, 250]) {
    await moveCallee(page, y);
    await paired();
  }
  await page.keyboard.press('ControlOrMeta+z');
  await nextFrames(page);
  await paired();
  await expect(page.locator('.dc-save')).toContainText('Saved locally');
  await page.reload();
  await expect(response).toHaveText('Customer found');
  await cameraAtRest(page);
  await paired();
});
