import type { Scene } from '../types';
import { REST, actor, edge, middle, queue, service, store } from './kit';

const orders = queue('orders', 60, 70, 'Orders');
const worker = service('worker', 360, 76, 'Fulfilment', { serviceKind: 'worker' });

export const deadLetterQueue: Scene = {
  label: 'The Orders queue is selected, Add DLQ is chosen, and a dead-letter queue appears below it on a dashed dead-letters connector.',
  frames: [
    {
      ms: 800,
      step: 'Select a queue',
      add: { nodes: [orders, worker], edges: [edge('e1', 'orders', 'worker', { semantic: 'consumes', semanticsOrigin: 'explicit' })] },
      cursor: { ...REST, travel: 0 },
    },
    { ms: 700, cursor: { ...middle(orders), click: true }, select: ['orders'] },
    {
      ms: 1100,
      step: 'Add DLQ',
      overlay: {
        kind: 'popover',
        at: { x: 146, y: 142 },
        placement: 'below',
        controls: [
          { type: 'button', text: 'Add Consumer', icon: 'plus' },
          { type: 'button', text: 'Add DLQ', icon: 'plus' },
        ],
      },
      cursor: { x: 204, y: 176 },
    },
    {
      ms: 500,
      overlay: {
        kind: 'popover',
        at: { x: 146, y: 142 },
        placement: 'below',
        controls: [
          { type: 'button', text: 'Add Consumer', icon: 'plus' },
          { type: 'button', text: 'Add DLQ', icon: 'plus', pressed: true },
        ],
      },
      cursor: { x: 204, y: 176, click: true },
    },
    {
      ms: 2200,
      step: 'Failures land there',
      add: {
        nodes: [queue('dlq', 60, 236, '', { deliveryRole: 'dead-letter' })],
        edges: [edge('e2', 'orders', 'dlq', { semantic: 'deadLetters', async: true, deliveryAttempts: 3, semanticsOrigin: 'explicit' })],
      },
      select: [],
      cursor: { x: 330, y: 300 },
    },
  ],
};

const source = service('orders', 56, 146, 'Orders');

export const intentContinuation: Scene = {
  label:
    'Orders is selected and a faint ghost suggests adding a Data Store. Pressing ] swaps the suggestion for a Topic, and Tab accepts it, making it real.',
  frames: [
    { ms: 800, step: 'Select a shape', add: { nodes: [source] }, cursor: { ...REST, travel: 0 } },
    { ms: 600, cursor: { ...middle(source), click: true }, select: ['orders'] },
    {
      ms: 1500,
      step: 'A ghost suggests a next move',
      add: { nodes: [store('db', 350, 136, 'Data Store')], edges: [edge('g1', 'orders', 'db')] },
      ghost: ['db', 'g1'],
      overlay: { kind: 'pill', at: { x: 412, y: 238 }, text: 'Add Data Store', keys: ['tab'] },
      cursor: { x: 190, y: 250 },
    },
    { ms: 700, step: '] for another idea', ghost: ['db', 'g1'], overlay: { kind: 'keys', keys: [']'] } },
    {
      ms: 1400,
      remove: ['db'],
      add: { nodes: [queue('topic', 350, 140, 'Order Events', { queueKind: 'topic' })], edges: [edge('g2', 'orders', 'topic')] },
      ghost: ['topic', 'g2'],
      overlay: { kind: 'pill', at: { x: 414, y: 236 }, text: 'Add Topic', keys: ['tab'] },
    },
    { ms: 700, step: 'Tab accepts it', ghost: ['topic', 'g2'], overlay: { kind: 'keys', keys: ['tab'] } },
    { ms: 2000, select: ['topic'] },
  ],
};

const producer = service('producer', 12, 150, 'Orders', { width: 112, height: 52 });
const events = queue('events', 160, 140, 'Order Events', { queueKind: 'topic', width: 116 });
const billing = queue('billing', 312, 52, '', { width: 104 });
const shipping = queue('shipping', 312, 246, '', { width: 104 });
const billingWorker = service('billing-worker', 446, 50, 'Billing', { serviceKind: 'worker', width: 104, height: 52 });
const shippingWorker = service('shipping-worker', 446, 244, 'Shipping', { serviceKind: 'worker', width: 104, height: 52 });

export const starters: Scene = {
  label: 'The command palette opens, "event" is typed, Event-Driven is chosen, and a producer, topic, two queues and two workers bloom onto the canvas.',
  frames: [
    { ms: 800, step: 'Open the command palette', overlay: { kind: 'keys', keys: ['mod', 'k'] } },
    { ms: 700, step: 'Type a pattern', overlay: { kind: 'palette', query: 'ev', rows: [{ title: 'Event-Driven', hint: 'Architectures' }] } },
    { ms: 1100, overlay: { kind: 'palette', query: 'event', rows: [{ title: 'Event-Driven', hint: 'Architectures' }], highlight: 0 } },
    { ms: 600, step: 'Enter', overlay: { kind: 'keys', keys: ['enter'] } },
    { ms: 380, add: { nodes: [producer, events], edges: [edge('e1', 'producer', 'events')] } },
    {
      ms: 380,
      add: { nodes: [billing, shipping], edges: [edge('e2', 'events', 'billing'), edge('e3', 'events', 'shipping')] },
    },
    {
      ms: 2300,
      add: {
        nodes: [billingWorker, shippingWorker],
        edges: [edge('e4', 'billing', 'billing-worker'), edge('e5', 'shipping', 'shipping-worker')],
      },
    },
  ],
};


/* ------------------------------------------------------------- look inside -- */

const borrower = actor('borrower', 44, 40, 'Borrower');
const platform = service('platform', 200, 52, 'Lending Platform');
const core = service('core', 372, 52, 'Core Banking', { serviceKind: 'external' });

const app = service('app', 190, 44, 'Mobile App', { width: 128, height: 52 });
const api = service('api', 360, 44, 'Lending API', { serviceKind: 'api', width: 128, height: 52 });
const loans = service('loans', 360, 154, 'Loan Service', { width: 128, height: 52 });
const loansDb = store('loans-db', 372, 260, 'Loans', { width: 104, height: 64 });

const insidePopover = (pressed: boolean) =>
  ({
    kind: 'popover',
    at: { x: 176, y: 128 },
    placement: 'below',
    controls: [{ type: 'button', text: 'Look inside', icon: 'depth', pressed }],
  }) as const;

export const lookInside: Scene = {
  label:
    'A system context diagram: a borrower, the Lending Platform and Core Banking. The platform is selected and Look inside is chosen: the canvas becomes what runs inside it — an app, an API, a service and its data store — while the depth map in the corner shows the whole canvas above and the platform as where you are. Command and up arrow comes back out to the big picture.',
  frames: [
    {
      ms: 900,
      step: 'Start with the big picture',
      add: {
        nodes: [borrower, platform, core],
        edges: [edge('e1', 'borrower', 'platform'), edge('e2', 'platform', 'core')],
      },
      cursor: { ...REST, travel: 0 },
    },
    { ms: 700, step: 'Look inside', cursor: { ...middle(platform), click: true }, select: ['platform'] },
    { ms: 1100, overlay: insidePopover(false), cursor: { x: 232, y: 162 } },
    { ms: 500, overlay: insidePopover(true), cursor: { x: 232, y: 162, click: true } },
    {
      ms: 1900,
      step: 'Draw what runs there',
      remove: ['borrower', 'platform', 'core'],
      select: [],
      add: {
        nodes: [app, api, loans, loansDb],
        edges: [edge('e3', 'app', 'api'), edge('e4', 'api', 'loans'), edge('e5', 'loans', 'loans-db')],
      },
      cursor: null,
    },
    { ms: 2200, overlay: { kind: 'depth', trail: ['Lending', 'Lending Platform'] } },
    { ms: 1000, step: 'Come back out', overlay: { kind: 'keys', keys: ['mod', 'up'] } },
    {
      ms: 2000,
      remove: ['app', 'api', 'loans', 'loans-db'],
      add: {
        nodes: [borrower, platform, core],
        edges: [edge('e1', 'borrower', 'platform'), edge('e2', 'platform', 'core')],
      },
      select: ['platform'],
    },
  ],
};
