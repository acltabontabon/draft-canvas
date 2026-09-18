/**
 * The gestures the interaction benchmark performs — every one driven with real mouse and keyboard
 * events through Playwright (synthetic events dispatched from inside the page do not drive React
 * Flow), paced at one pointer event per animation frame, which is what a 60 Hz person produces.
 *
 * A scenario has two halves. `prepare` picks its targets from what is actually on screen and puts
 * the app in the state the gesture starts from; it is never measured. `run` is only the gesture.
 * Recording, the settle tail after it and the aggregation live in `run.ts`, so the same fixture
 * and viewport always yield the same gesture and the same window of measurement.
 */

import type { Page } from '@playwright/test';
import { nextFrame, settle } from './recorder';

export interface ScenarioContext {
  page: Page;
  /** The canvas's own box in page coordinates — gestures stay inside it, clear of toolbars. */
  area: { x: number; y: number; width: number; height: number };
  /** Ids of the free-floating notes the fixture places on open canvas. */
  looseNoteIds: string[];
}

export type Notes = Record<string, number | string>;

export interface Point {
  x: number;
  y: number;
}

export interface Scenario {
  id: string;
  title: string;
  /** How long to keep watching after the gesture: autosave is debounced 700 ms, so commit and
   *  viewport-save work lands here rather than inside the gesture. */
  tailMs: number;
  /** Unmeasured. Whatever it returns is handed to `run`. */
  prepare?(context: ScenarioContext): Promise<Prepared>;
  /** Measured: only the gesture. */
  run(context: ScenarioContext, prepared: Prepared): Promise<Notes>;
  /** Unmeasured. Puts the document back so the next iteration starts from the same place. */
  restore?(context: ScenarioContext): Promise<void>;
}

/** Prepared state is scenario-private; each scenario reads back exactly what it put in. */
export type Prepared = Record<string, unknown>;

interface Box {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const centre = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const centreOf = (area: ScenarioContext['area']): Point => ({ x: area.x + area.width / 2, y: area.y + area.height / 2 });

/** Every node whose centre is currently inside `area`, with its box in page coordinates. */
async function visibleNodes(page: Page, area: ScenarioContext['area']): Promise<Box[]> {
  return (await page.evaluate(
    `(() => {
      const area = ${JSON.stringify(area)};
      const out = [];
      for (const wrapper of document.querySelectorAll('.react-flow__node')) {
        const inner = wrapper.querySelector('.dc-node');
        if (!inner) continue;
        const r = wrapper.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (cx < area.x || cx > area.x + area.width || cy < area.y || cy > area.y + area.height) continue;
        out.push({ id: wrapper.getAttribute('data-id') || '', type: inner.getAttribute('data-type') || '',
                   x: r.x, y: r.y, width: r.width, height: r.height });
      }
      return out;
    })()`,
  )) as Box[];
}

function nearestTo(boxes: readonly Box[], point: Point): Box | undefined {
  let best: Box | undefined;
  let bestDistance = Infinity;
  for (const box of boxes) {
    const c = centre(box);
    const distance = Math.hypot(c.x - point.x, c.y - point.y);
    if (distance < bestDistance) {
      best = box;
      bestDistance = distance;
    }
  }
  return best;
}

/** Moves the pointer from `from` to `to` in `steps` frame-paced steps. */
async function glide(page: Page, from: Point, to: Point, steps: number): Promise<void> {
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await nextFrame(page);
  }
}

const undo = (page: Page) => page.keyboard.press('ControlOrMeta+z');

/** A leaf shape nearest the middle of the screen with nothing overlapping its centre. */
async function pickLeaf(context: ScenarioContext, exclude: readonly string[] = []): Promise<Box> {
  const nodes = await visibleNodes(context.page, context.area);
  const leaves = nodes.filter((n) => n.type !== 'group' && n.type !== 'note' && !exclude.includes(n.id));
  const clear: Box[] = [];
  for (const node of leaves) {
    const c = centre(node);
    const topmost = await context.page.evaluate(
      `(() => { const el = document.elementFromPoint(${c.x}, ${c.y}); const w = el && el.closest('.react-flow__node'); return w ? w.getAttribute('data-id') : ''; })()`,
    );
    if (topmost === node.id) clear.push(node);
  }
  const chosen = nearestTo(clear, centreOf(context.area));
  if (!chosen) throw new Error('No unobstructed shape on screen to pick.');
  return chosen;
}

/** A container boundary (system → **container** → domain); its id, `s<i>c<j>`, says which. */
async function pickContainer(context: ScenarioContext): Promise<Box> {
  const nodes = await visibleNodes(context.page, context.area);
  const chosen = nearestTo(
    nodes.filter((n) => /^s\d+c\d$/.test(n.id)),
    centreOf(context.area),
  );
  if (!chosen) throw new Error('No container boundary on screen to pick.');
  return chosen;
}

const STEPS = 90;

export const SCENARIOS: Scenario[] = [
  {
    id: 'pan-drag',
    title: 'Pan by dragging (middle button), then back',
    tailMs: 1600,
    async run({ page, area }) {
      const start = centreOf(area);
      const far = { x: start.x - 540, y: start.y - 315 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down({ button: 'middle' });
      await glide(page, start, far, STEPS);
      await glide(page, far, start, STEPS);
      await page.mouse.up({ button: 'middle' });
      return { steps: STEPS * 2 };
    },
  },
  {
    id: 'pan-wheel',
    title: 'Pan with the scroll wheel, then back',
    tailMs: 1600,
    async run({ page, area }) {
      const at = centreOf(area);
      await page.mouse.move(at.x, at.y);
      for (let step = 0; step < 60; step += 1) {
        await page.mouse.wheel(24, 32);
        await nextFrame(page);
      }
      for (let step = 0; step < 60; step += 1) {
        await page.mouse.wheel(-24, -32);
        await nextFrame(page);
      }
      return { steps: 120 };
    },
  },
  {
    id: 'zoom-wheel',
    title: 'Zoom in and out with Ctrl+wheel',
    tailMs: 1600,
    async run({ page, area }) {
      const at = centreOf(area);
      await page.mouse.move(at.x, at.y);
      await page.keyboard.down('Control');
      for (let step = 0; step < 36; step += 1) {
        await page.mouse.wheel(0, -60);
        await nextFrame(page);
      }
      for (let step = 0; step < 36; step += 1) {
        await page.mouse.wheel(0, 60);
        await nextFrame(page);
      }
      await page.keyboard.up('Control');
      return { steps: 72 };
    },
  },
  {
    id: 'drag-single',
    title: 'Drag one shape',
    tailMs: 1200,
    async prepare(context) {
      return { node: await pickLeaf(context) };
    },
    async run({ page }, { node }) {
      const from = centre(node as Box);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await glide(page, from, { x: from.x + 220, y: from.y + 110 }, STEPS);
      await page.mouse.up();
      return { node: (node as Box).id };
    },
    restore: ({ page }) => undo(page),
  },
  {
    id: 'drag-multi',
    title: 'Drag a multi-selection (8 shapes)',
    tailMs: 1200,
    async prepare(context) {
      const { page } = context;
      const picked: Box[] = [];
      for (let i = 0; i < 8; i += 1) {
        const next = await pickLeaf(context, picked.map((p) => p.id));
        picked.push(next);
        const at = centre(next);
        if (i > 0) await page.keyboard.down('Shift');
        await page.mouse.click(at.x, at.y);
        if (i > 0) await page.keyboard.up('Shift');
        await nextFrame(page);
      }
      const selected = await page.locator('.dc-node[data-selected="true"]').count();
      return { lead: picked[0], selected };
    },
    async run({ page }, { lead, selected }) {
      const from = centre(lead as Box);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await glide(page, from, { x: from.x + 180, y: from.y + 90 }, STEPS);
      await page.mouse.up();
      return { selected: selected as number };
    },
    restore: async ({ page }) => {
      await undo(page);
      await page.keyboard.press('Escape');
    },
  },
  {
    id: 'drag-boundary',
    title: 'Drag a boundary with everything nested inside it',
    tailMs: 1200,
    async prepare(context) {
      return { container: await pickContainer(context) };
    },
    async run({ page }, { container }) {
      const box = container as Box;
      // The boundary's own padding, clear of any child — the same grip the e2e suite uses.
      const from = { x: box.x + 8, y: box.y + 8 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await glide(page, from, { x: from.x + 160, y: from.y + 80 }, STEPS);
      await page.mouse.up();
      return { boundary: box.id };
    },
    restore: ({ page }) => undo(page),
  },
  {
    id: 'drag-note',
    title: 'Drag a Note across dense connectors (attach probing)',
    tailMs: 1200,
    async prepare({ page, area, looseNoteIds }) {
      const note = (await visibleNodes(page, area)).find((n) => looseNoteIds.includes(n.id));
      if (!note) throw new Error('No loose Note on screen.');
      return { note };
    },
    async run({ page, area }, { note }) {
      const from = centre(note as Box);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await glide(page, from, { x: area.x + area.width * 0.55, y: from.y + 60 }, STEPS);
      await page.mouse.up();
      return { note: (note as Box).id };
    },
    restore: ({ page }) => undo(page),
  },
  {
    id: 'connect',
    title: 'Draw a connector between two shapes',
    tailMs: 1200,
    async prepare(context) {
      const { page } = context;
      const source = await pickLeaf(context);
      const target = await pickLeaf(context, [source.id]);
      const at = centre(source);
      await page.mouse.move(at.x, at.y);
      await nextFrame(page);
      const handle = await page.locator(`.react-flow__node[data-id="${source.id}"] .dc-handle`).nth(1).boundingBox();
      if (!handle) throw new Error('Source handle was not revealed.');
      return { source, target, from: { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 } };
    },
    async run({ page }, { source, target, from }) {
      const start = from as Point;
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await glide(page, start, centre(target as Box), 40);
      await page.mouse.up();
      return { from: (source as Box).id, to: (target as Box).id };
    },
    restore: ({ page }) => undo(page),
  },
  {
    id: 'hover-sweep',
    title: 'Sweep the pointer across the canvas (hover, no buttons)',
    tailMs: 400,
    async run({ page, area }) {
      const y = area.y + area.height * 0.5;
      const left = { x: area.x + 40, y: y - 120 };
      const right = { x: area.x + area.width - 40, y: y + 120 };
      await page.mouse.move(left.x, left.y);
      await glide(page, left, right, 120);
      await glide(page, right, left, 120);
      return { steps: 240 };
    },
  },
  {
    id: 'select-clicks',
    title: 'Click through 16 shapes in a row (selection latency)',
    tailMs: 600,
    async prepare(context) {
      const nodes = (await visibleNodes(context.page, context.area)).filter(
        (n) => n.type !== 'group' && n.type !== 'note',
      );
      return { nodes: nodes.slice(0, 16) };
    },
    async run({ page }, { nodes }) {
      for (const node of nodes as Box[]) {
        const at = centre(node);
        await page.mouse.click(at.x, at.y);
        await nextFrame(page);
      }
      return { clicked: (nodes as Box[]).length };
    },
    restore: ({ page }) => page.keyboard.press('Escape'),
  },
  {
    id: 'type-label',
    title: 'Rename a shape: type 30 characters, then commit',
    tailMs: 1200,
    async prepare(context) {
      const { page } = context;
      const node = await pickLeaf(context);
      const at = centre(node);
      await page.mouse.click(at.x, at.y);
      await nextFrame(page);
      await page.keyboard.press('Enter');
      await page.locator('.dc-node-editor').waitFor({ state: 'visible' });
      await page.keyboard.press('ControlOrMeta+a');
      return { node };
    },
    async run({ page, area }, { node }) {
      await page.keyboard.type('Payment Reconciliation Service X', { delay: 16 });
      // Committed by clicking away — Escape reverts a label, and the commit is what does the work.
      await page.mouse.click(area.x + 30, area.y + 30);
      return { node: (node as Box).id };
    },
    restore: ({ page }) => undo(page),
  },
  {
    id: 'panels',
    title: 'Open and close the palette, Flows and Takeaways',
    tailMs: 600,
    async run({ page }) {
      for (let round = 0; round < 3; round += 1) {
        await page.keyboard.press('ControlOrMeta+k');
        await page.getByRole('dialog', { name: 'Commands' }).waitFor({ state: 'visible' });
        await settle(page, 2);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog', { name: 'Commands' }).waitFor({ state: 'hidden' });
        await page.locator('.dc-flow-toggle').click();
        await settle(page, 4);
        await page.locator('.dc-flow-toggle').click();
        await settle(page, 4);
        await page.keyboard.press('i');
        await page.locator('.dc-takeaways-capture input').waitFor({ state: 'visible' });
        await settle(page, 2);
        await page.keyboard.press('Escape');
        await settle(page, 2);
      }
      return { rounds: 3 };
    },
  },
];

export const SCENARIO_IDS = SCENARIOS.map((scenario) => scenario.id);
