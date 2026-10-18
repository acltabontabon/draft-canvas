import { expect, test } from '@playwright/test';
import { newCanvas } from './canvas';

test('Quiet corner logos keep full branded and custom details across edits and undo', async ({ page }) => {
  await newCanvas(page, 'Technology logos');
  await page.evaluate(async () => {
    const { createNode } = await import('/src/document/factory.ts');
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const store = useEditorStore.getState();
    store.setDocument({
      ...store.document,
      nodes: [
        createNode({ id: 'pg', type: 'database', databaseKind: 'sql', x: 180, y: 130, text: 'Orders', technology: 'PostgreSQL 16' }),
        createNode({ id: 'api', type: 'service', serviceKind: 'api', x: 460, y: 130, text: 'Orders API', technology: 'Node.js 22' }),
        createNode({ id: 'cache', type: 'database', databaseKind: 'cache', x: 180, y: 350, text: 'Session cache', technology: 'Redis 7' }),
        createNode({ id: 'queue', type: 'queue', x: 460, y: 350, text: 'Events', technology: 'RabbitMQ 4' }),
      ],
      edges: [],
    }, { resetHistory: true });
  });

  for (const technology of ['PostgreSQL 16', 'Node.js 22', 'Redis 7', 'RabbitMQ 4']) {
    const button = page.getByRole('button', { name: `Technology: ${technology}`, exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.dc-technology-detail:visible')).toHaveText(technology);
    await button.press('Escape');
    await expect(page.locator('.dc-technology-detail:visible')).toHaveCount(0);
  }

  const postgres = page.getByRole('button', { name: 'Technology: PostgreSQL 16', exact: true });
  await postgres.focus();
  await postgres.press('Enter');
  await expect(postgres).toHaveAttribute('aria-expanded', 'true');
  await postgres.press('Escape');

  const node = page.locator('.react-flow__node[data-id="pg"]');
  await expect(node.locator('.dc-node-surface text')).not.toContainText(['[PostgreSQL 16]']);
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    useEditorStore.getState().setNodeC4Text('pg', { technology: 'Internal engine' });
  });
  await expect(node.getByRole('button', { name: 'Technology: Internal engine' })).toBeVisible();
  await expect(node.locator('.dc-node-surface')).not.toContainText('[Internal engine]');
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    useEditorStore.getState().undo();
  });
  await expect(postgres).toBeVisible();
  await expect(postgres).toHaveAttribute('aria-expanded', 'false');
  await expect(node.locator('.dc-node-surface')).not.toContainText('[Internal engine]');
});

test('Technology typeahead supports pointer, keyboard, generic fallback and clearing', async ({ page }) => {
  await newCanvas(page, 'Technology typeahead');
  await page.evaluate(async () => {
    const { createNode } = await import('/src/document/factory.ts');
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const store = useEditorStore.getState();
    store.setDocument({ ...store.document, nodes: [createNode({ id: 'orders', type: 'service', x: 300, y: 260, text: 'Orders' })], edges: [] }, { resetHistory: true });
  });
  const node = page.locator('.react-flow__node[data-id="orders"]');
  await node.click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const field = page.getByRole('combobox', { name: 'Technology', exact: true });
  await field.fill('post 16');
  const option = page.getByRole('option', { name: 'PostgreSQL 16', exact: true });
  await expect(option.locator('svg path')).toHaveCount(1);
  await field.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Technologies with icons' })).toHaveCount(0);
  await expect(field).toBeVisible();
  await field.press('ArrowDown');
  await field.press('Enter');
  await expect(node.getByRole('button', { name: 'Technology: PostgreSQL 16' })).toBeVisible();

  await field.fill('rab');
  await page.getByRole('option', { name: 'RabbitMQ', exact: true }).click();
  await expect(field).toHaveValue('RabbitMQ');
  await expect(node.getByRole('button', { name: 'Technology: RabbitMQ' })).toBeVisible();

  await field.fill('Private runtime');
  await expect(page.locator('.dc-technology-custom')).toContainText('generic icon');
  await field.press('Enter');
  const custom = node.getByRole('button', { name: 'Technology: Private runtime' });
  await expect(custom).toBeVisible();
  await custom.click();
  await expect(page.locator('.dc-technology-detail:visible')).toHaveText('Private runtime');
  // Clicking outside the inspector closes Details; reopen it to clear the saved technology.
  await node.click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await field.fill('');
  await field.press('Tab');
  await expect(node.locator('.dc-technology-target')).toHaveCount(0);
});
