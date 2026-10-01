import { expect, test, type Page } from '@playwright/test';

/**
 * The same diagram open in two tabs. Draft Canvas checks every save against what the other tab last
 * stored, and asks which copy to keep when they disagree — which is right when somebody *edited*, and
 * a false alarm when all they did was look around: panning and zooming are saved too (so a diagram
 * reopens where it was left), and used to count as a change to the diagram.
 */

const diagram = {
  format: 'draft-canvas',
  version: 1,
  metadata: { id: 'two-tabs', title: 'Two tabs', createdAt: 1, updatedAt: 2 },
  nodes: [
    { id: 'a', type: 'service', x: 100, y: 100, width: 160, height: 70, z: 0, text: 'A' },
    { id: 'b', type: 'service', x: 420, y: 100, width: 160, height: 70, z: 0, text: 'B' },
  ],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  settings: { showSequence: true, grid: 'dots' },
};

test('looking around in one tab does not make the other tab conflict on its next edit', async ({ context }) => {
  const one = await context.newPage();
  await one.goto('/');
  await one.setInputFiles('input[type="file"]', {
    name: 'two-tabs.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(diagram)),
  });
  await one.waitForSelector('.dc-editor');
  await expect(one.locator('.dc-save')).toContainText('Saved locally');

  const two = await context.newPage();
  await two.goto('/');
  await two.locator('.dc-library-item', { hasText: 'Two tabs' }).click();
  await two.waitForSelector('.dc-editor');
  await expect(two.locator('.dc-save')).toContainText('Saved locally');

  // Tab one only looks around: no content changes at all.
  await one.bringToFront();
  await one.mouse.move(800, 500);
  for (let i = 0; i < 6; i += 1) await one.mouse.wheel(30, 20);
  // The gesture's end is what the editor keeps (`persistViewport`, from React Flow's `onMoveEnd`);
  // only then is there a camera to save — the opening's own fit is never one.
  await expect.poll(() => liveViewportOf(one), { message: 'the pan is the camera the editor keeps' }).not.toBeNull();
  // Then past the autosave debounce: the camera move has really been written before tab two saves.
  await expect.poll(async () => sameViewport(await storedViewportOf(one), await liveViewportOf(one)), {
    message: 'the stored copy carries the pan',
  }).toBe(true);
  await expect(one.locator('.dc-save')).toContainText('Saved locally');

  // Tab two makes a real edit, and is not told the canvas changed underneath it.
  await two.bringToFront();
  const box = (await two.locator('.dc-node').first().boundingBox())!;
  await two.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await two.mouse.down();
  await two.mouse.move(box.x + 200, box.y + 120, { steps: 8 });
  await two.mouse.up();
  // The edit has landed in storage: a conflict would have stopped this save from ever being written,
  // so once the stored shape matches the moved one, the save went through and nothing asked.
  await expect.poll(async () => (await storedNodeXOf(two)) === (await nodeXOf(two)), {
    message: 'the stored copy carries the move',
  }).toBe(true);

  await expect(two.locator('.dc-save-conflict')).toHaveCount(0);
  await expect(two.locator('.dc-save')).toContainText('Saved locally');
});

type Viewport = { x: number; y: number; zoom: number };

/** The camera a gesture left behind, as the editor would save it — `null` until one has. */
const liveViewportOf = (page: Page): Promise<Viewport | null> =>
  page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    return useEditorStore.getState().liveViewport;
  });

/**
 * The stored copy, read straight out of the `bodies` row (`IndexedDbRepository.ts`'s plain body)
 * rather than through the app's repository: its `load()` records the row's stamp as what this tab
 * last saw, which is exactly what a save checks for a conflict — reading through it from tab two
 * would hide the conflict this test exists to rule out — and writes a migrated copy back.
 */
const storedDocumentOf = (page: Page): Promise<{ viewport: Viewport; nodes: { id: string; x: number }[] } | null> =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('draft-canvas');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('bodies', 'readonly').objectStore('bodies').get('two-tabs');
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            db.close();
            resolve(get.result?.document ?? null);
          };
        };
      }),
  );

const storedViewportOf = async (page: Page): Promise<Viewport | null> => (await storedDocumentOf(page))?.viewport ?? null;

const sameViewport = (a: Viewport | null, b: Viewport | null) =>
  a !== null && b !== null && a.x === b.x && a.y === b.y && a.zoom === b.zoom;

const nodeXOf = (page: Page): Promise<number | undefined> =>
  page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    return useEditorStore.getState().document.nodes.find((node: { id: string }) => node.id === 'a')?.x;
  });

const storedNodeXOf = async (page: Page): Promise<number | undefined> =>
  (await storedDocumentOf(page))?.nodes.find((node) => node.id === 'a')?.x;
