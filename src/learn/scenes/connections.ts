import type { Scene } from '../types';
import { REST, edge, junction, queue, service } from './kit';

const orders = service('orders', 40, 52, 'Orders');
const payments = service('payments', 344, 52, 'Payments');

export const connect: Scene = {
  label:
    'A handle on Orders is dragged onto Payments and a connector appears. Then a handle on Payments is dropped on empty canvas, a picker offers shapes, and choosing Queue adds one already connected.',
  frames: [
    { ms: 700, step: 'Drag from a handle', add: { nodes: [orders, payments] }, cursor: { ...REST, travel: 0 } },
    { ms: 700, cursor: { x: 150, y: 88 }, handles: 'orders' },
    { ms: 400, cursor: { x: 184, y: 81, down: true, travel: 260 } },
    { ms: 900, cursor: { x: 412, y: 84, down: true, travel: 820 }, handles: 'payments' },
    { ms: 1300, step: 'Drop on another shape', handles: null, cursor: { x: 412, y: 84 }, add: { edges: [edge('e1', 'orders', 'payments')] } },
    { ms: 600, step: 'Or drop on empty canvas', handles: 'payments', cursor: { x: 430, y: 104 } },
    { ms: 400, cursor: { x: 416, y: 110, down: true, travel: 260 } },
    { ms: 800, handles: null, cursor: { x: 416, y: 176, down: true, travel: 640 } },
    {
      ms: 1200,
      overlay: { kind: 'picker', at: { x: 416, y: 176 }, title: 'Add element', items: ['Service', 'Data Store', 'Queue', 'Actor'], highlight: 'Queue' },
      cursor: { x: 440, y: 256 },
    },
    {
      ms: 1700,
      add: { nodes: [queue('q', 352, 232)], edges: [edge('e2', 'payments', 'q')] },
      cursor: { x: 470, y: 310 },
    },
  ],
};

const svcOrders = service('orders', 40, 146, 'Orders');
const topic = queue('topic', 356, 138, 'Order Events', { queueKind: 'topic' });

export const describeInteraction: Scene = {
  label: 'A connector from Orders to the Order Events topic is selected, Interaction type is set to Publishes, and the line is labelled publishes.',
  frames: [
    { ms: 800, step: 'Select the connector', add: { nodes: [svcOrders, topic], edges: [edge('e1', 'orders', 'topic')] }, cursor: { ...REST, travel: 0 } },
    { ms: 700, cursor: { x: 270, y: 175, click: true }, select: ['e1'] },
    {
      ms: 900,
      step: 'Pick an interaction type',
      overlay: { kind: 'popover', at: { x: 270, y: 150 }, controls: [{ type: 'select', label: 'Interaction type', value: 'No type' }] },
      cursor: { x: 268, y: 116, click: true },
    },
    {
      ms: 1300,
      cursor: { x: 262, y: 152, travel: 380 },
      overlay: {
        kind: 'popover',
        at: { x: 270, y: 150 },
        controls: [
          { type: 'select', label: 'Interaction type', value: 'No type', options: ['Publishes', 'Event', 'Command'], highlight: 'Publishes' },
        ],
      },
    },
    {
      ms: 2000,
      step: 'The line says it',
      update: { edges: { e1: { semantic: 'publishes', semanticsOrigin: 'explicit' } } },
      select: [],
      cursor: { x: 300, y: 300 },
    },
  ],
};

const caller = service('orders', 40, 146, 'Orders');
const callee = service('emails', 372, 146, 'Emails');

export const makeAsync: Scene = {
  label: 'A call from Orders to Emails is selected, Interaction mode is switched from Sync to Async, and a break mark appears on the line.',
  frames: [
    { ms: 800, step: 'Select the call', add: { nodes: [caller, callee], edges: [edge('e1', 'orders', 'emails', { semantic: 'calls' })] }, cursor: { ...REST, travel: 0 } },
    { ms: 700, cursor: { x: 280, y: 175, click: true }, select: ['e1'] },
    {
      ms: 900,
      step: 'Mode → Async',
      overlay: {
        kind: 'popover',
        at: { x: 280, y: 150 },
        controls: [
          { type: 'select', label: 'Protocol', value: 'Generic Call' },
          { type: 'select', label: 'Interaction mode', value: 'Sync' },
        ],
      },
      cursor: { x: 342, y: 114, click: true },
    },
    {
      ms: 1300,
      cursor: { x: 324, y: 178, travel: 380 },
      overlay: {
        kind: 'popover',
        at: { x: 280, y: 150 },
        controls: [
          { type: 'select', label: 'Protocol', value: 'Generic Call' },
          { type: 'select', label: 'Interaction mode', value: 'Sync', options: ['Sync', 'Async'], highlight: 'Async' },
        ],
      },
    },
    {
      ms: 2000,
      step: 'The line breaks',
      update: { edges: { e1: { kind: 'async', semanticsOrigin: 'explicit' } } },
      select: [],
      cursor: { x: 300, y: 300 },
    },
  ],
};

const web = service('web', 40, 146, 'Storefront');
const api = service('api', 372, 146, 'Orders API', { serviceKind: 'api' });

export const addResponse: Scene = {
  label: 'A GET /orders call is selected, Response is turned on, and a quieter reply line labelled 200 Orders draws back to the caller.',
  frames: [
    {
      ms: 800,
      step: 'Select the call',
      add: {
        nodes: [web, api],
        edges: [edge('e1', 'web', 'api', { semantic: 'http', label: 'GET /orders', semanticsOrigin: 'explicit' })],
      },
      cursor: { ...REST, travel: 0 },
    },
    { ms: 700, cursor: { x: 280, y: 175, click: true }, select: ['e1'] },
    {
      ms: 1100,
      step: 'Turn Response on',
      overlay: { kind: 'popover', at: { x: 280, y: 140 }, controls: [{ type: 'toggle', label: 'Response', on: false }] },
      cursor: { x: 306, y: 110 },
    },
    {
      ms: 500,
      cursor: { x: 306, y: 110, click: true },
      overlay: { kind: 'popover', at: { x: 280, y: 140 }, controls: [{ type: 'toggle', label: 'Response', on: true, pressed: true }] },
    },
    {
      ms: 2000,
      step: 'The reply draws back',
      update: { edges: { e1: { hasResponse: true, response: '200 Orders' } } },
      select: [],
      cursor: { x: 300, y: 300 },
    },
  ],
};

const card = {
  id: 'card',
  type: 'code' as const,
  x: 176,
  y: 214,
  width: 210,
  height: 96,
  language: 'json' as const,
  code: '{\n  "orderId": "o_42",\n  "amount": 1999\n}',
};

export const attachToConnector: Scene = {
  label: 'A JSON code card is dragged onto the connector between Checkout and Payments; on release it becomes a code chip sitting on the line.',
  frames: [
    {
      ms: 900,
      step: 'Drag a code card onto the line',
      add: {
        nodes: [service('checkout', 30, 60, 'Checkout'), service('payments', 386, 60, 'Payments'), card],
        edges: [edge('e1', 'checkout', 'payments', { semantic: 'http', label: 'POST /charge', semanticsOrigin: 'explicit' })],
      },
      cursor: { ...REST, travel: 0 },
    },
    { ms: 600, cursor: { x: 280, y: 232 } },
    { ms: 400, cursor: { x: 280, y: 232, down: true }, select: ['card'] },
    { ms: 900, update: { nodes: { card: { x: 176, y: 72 } } }, moving: ['card'], cursor: { x: 280, y: 90, down: true, travel: 860 } },
    {
      ms: 1200,
      step: 'Hold, then let go',
      moving: ['card'],
      select: ['e1'],
      overlay: { kind: 'pill', at: { x: 280, y: 190 }, text: 'Attach to POST /charge' },
    },
    { ms: 1900, step: 'It sits on the line', remove: ['card'], chips: { e1: ['code'] }, select: [], cursor: { x: 320, y: 290 } },
  ],
};

const gateway = service('gateway', 24, 146, 'Gateway', { serviceKind: 'gateway' });
const hub = junction('hub', 226, 161);
const targets = [
  service('orders', 366, 36, 'Orders'),
  service('payments', 366, 146, 'Payments'),
  service('search', 366, 256, 'Search'),
];

export const junctionScene: Scene = {
  label: 'A Gateway routes into a junction, and three connectors branch out of it to Orders, Payments and Search with their own labels.',
  frames: [
    { ms: 800, step: 'Drop a junction', add: { nodes: [gateway, ...targets] }, cursor: { x: 250, y: 190, travel: 0 } },
    { ms: 1000, overlay: { kind: 'keys', keys: ['j'] }, add: { nodes: [hub] }, cursor: { x: 262, y: 214 } },
    { ms: 900, step: 'Route into it', add: { edges: [edge('in', 'gateway', 'hub', { routing: 'straight' })] } },
    { ms: 650, step: 'Branch out', add: { edges: [edge('b1', 'hub', 'orders', { label: '/orders' })] } },
    { ms: 650, add: { edges: [edge('b2', 'hub', 'payments', { label: '/pay' })] } },
    { ms: 2000, add: { edges: [edge('b3', 'hub', 'search', { label: '/search' })] } },
  ],
};
