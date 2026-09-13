import type { Scene, SceneEdgeSpec, SceneNodeSpec } from '../types';
import { REST, edge, service, store } from './kit';

/** One small checkout system, shared by every flow scene so they read as the same story. */
const NODES: SceneNodeSpec[] = [
  service('checkout', 12, 104, 'Checkout', { width: 116 }),
  service('orders', 222, 104, 'Orders', { width: 116 }),
  service('payments', 432, 104, 'Payments', { width: 116 }),
  store('inventory', 218, 238, 'Inventory'),
];

const EDGES: SceneEdgeSpec[] = [
  edge('e1', 'checkout', 'orders', { label: 'place order' }),
  edge('e2', 'orders', 'payments', { label: 'charge card' }),
  edge('e3', 'orders', 'inventory', { semantic: 'writes', semanticsOrigin: 'explicit' }),
];

export const addToFlow: Scene = {
  label:
    'The Checkout to Orders connector is selected and added to a new flow, showing step 1. Then Orders to Payments is added as step 2, and everything outside the flow dims.',
  frames: [
    { ms: 800, step: 'Select a connector', add: { nodes: NODES, edges: EDGES }, cursor: { ...REST, travel: 0 } },
    { ms: 700, cursor: { x: 175, y: 134, click: true }, select: ['e1'] },
    {
      ms: 1000,
      step: 'Add to flow',
      overlay: { kind: 'popover', at: { x: 175, y: 96 }, controls: [{ type: 'chip', text: 'Add to flow' }] },
      cursor: { x: 186, y: 70 },
    },
    {
      ms: 500,
      overlay: { kind: 'popover', at: { x: 175, y: 96 }, controls: [{ type: 'chip', text: 'Add to flow', pressed: true }] },
      cursor: { x: 186, y: 70, click: true },
    },
    { ms: 900, flow: ['e1'] },
    { ms: 700, step: 'Next connector, next step', cursor: { x: 385, y: 134, click: true }, select: ['e2'] },
    {
      ms: 1000,
      overlay: { kind: 'popover', at: { x: 385, y: 96 }, controls: [{ type: 'chip', text: 'Add to Checkout', accent: true }] },
      cursor: { x: 398, y: 70 },
    },
    {
      ms: 500,
      overlay: { kind: 'popover', at: { x: 385, y: 96 }, controls: [{ type: 'chip', text: 'Add to Checkout', accent: true, pressed: true }] },
      cursor: { x: 398, y: 70, click: true },
    },
    { ms: 2000, flow: ['e1', 'e2'], select: [], dim: ['inventory', 'e3'], cursor: { x: 330, y: 316 } },
  ],
};

export const presentFlow: Scene = {
  label: 'Presentation starts; step 1 highlights Checkout placing the order, the right arrow key moves to step 2, Orders charging the card, and Escape ends it.',
  frames: [
    { ms: 1000, step: 'Start presenting', add: { nodes: NODES, edges: EDGES }, flow: ['e1', 'e2'], overlay: { kind: 'keys', keys: ['mod', 'enter'] } },
    {
      ms: 1900,
      step: 'Step through',
      dim: ['payments', 'e2', 'inventory', 'e3'],
      overlay: { kind: 'flowbar', step: 1, total: 2, caption: 'Checkout → Orders · place order' },
    },
    { ms: 700, dim: ['payments', 'e2', 'inventory', 'e3'], overlay: { kind: 'keys', keys: ['right'] } },
    {
      ms: 2100,
      dim: ['checkout', 'inventory', 'e3'],
      overlay: { kind: 'flowbar', step: 2, total: 2, caption: 'Orders → Payments · charge card' },
    },
    { ms: 1300, step: 'Esc to finish', overlay: { kind: 'keys', keys: ['esc'] } },
  ],
};

export const exportSequence: Scene = {
  label: 'A two-step flow is exported: Export, then Source, then Mermaid, producing a sequenceDiagram where Checkout calls Orders and Orders calls Payments.',
  frames: [
    { ms: 1000, step: 'Start from a flow', add: { nodes: NODES, edges: EDGES }, flow: ['e1', 'e2'] },
    { ms: 800, step: 'Export → Source', overlay: { kind: 'keys', keys: ['mod', 'e'] } },
    {
      ms: 1300,
      overlay: { kind: 'picker', at: { x: 280, y: 130 }, title: 'Export', items: ['Document', 'Image', 'Animated', 'Source'], highlight: 'Source' },
    },
    {
      ms: 1200,
      step: 'Pick Mermaid or PlantUML',
      overlay: { kind: 'picker', at: { x: 280, y: 150 }, title: 'Source', items: ['Mermaid', 'PlantUML'], highlight: 'Mermaid' },
    },
    {
      ms: 3000,
      step: 'Paste it anywhere',
      dim: ['checkout', 'orders', 'payments', 'inventory', 'e1', 'e2', 'e3'],
      overlay: {
        kind: 'code',
        at: { x: 280, y: 180 },
        title: 'checkout.mmd',
        lines: ['sequenceDiagram', '    Checkout->>Orders: place order', '    Orders->>Payments: charge card'],
      },
    },
  ],
};
