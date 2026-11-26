import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';

/**
 * Canvas Evolution, end to end in the browser: history is recorded with no step from the person,
 * survives a reload, and the timeline shows past revisions without touching the live diagram.
 * Recording waits 5 s here instead of 30 (Settings → History's own preference).
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('draft-canvas.history-idle', '5'));
});

const clock = (page: Page) => page.locator('.dc-history-chip');

async function recorded(page: Page) {
  await expect(clock(page)).toHaveAttribute('aria-label', /Every change is in this diagram’s history/, { timeout: 20_000 });
}

async function openTimeline(page: Page) {
  await clock(page).click();
  await page.getByRole('button', { name: 'Open timeline' }).click();
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
}

test('history is recorded in the background, survives a reload, and the past never changes the live diagram', async ({ page }) => {
  await newCanvas(page, 'Evolving');
  await create(page, 'Service', { x: 300, y: 200 });
  await recorded(page);
  await create(page, 'Data Store', { x: 600, y: 360 });
  await recorded(page);

  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await recorded(page);

  await openTimeline(page);
  // The status bar steps aside for the timeline.
  await expect(page.locator('.dc-editor')).toHaveAttribute('data-timeline', '');
  const marks = page.locator('.dc-timeline-mark');
  await expect(marks).not.toHaveCount(0);
  await marks.first().click();
  await expect(page.locator('.dc-history-lens')).toHaveCount(1);
  // Read-only while the lens is up: a shortcut adds nothing to the live diagram.
  await page.keyboard.press('s');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-history-lens')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
});

test('compares a revision with now, restores it as one undo step', async ({ page }) => {
  await newCanvas(page, 'Restorable');
  await create(page, 'Service', { x: 300, y: 200 });
  await recorded(page);
  await create(page, 'Queue', { x: 600, y: 200 });
  await recorded(page);
  await openTimeline(page);
  await page.locator('.dc-timeline-mark').first().click();
  await page.getByRole('button', { name: 'Compare with now' }).click();
  await expect(page.locator('.dc-compare-mark[data-mark="added"]')).toHaveCount(1);
  await page.keyboard.press('Escape');

  await page.locator('.dc-timeline-mark').first().click();
  await page.getByRole('button', { name: 'Restore…' }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await page.locator('.dc-canvas').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
});
