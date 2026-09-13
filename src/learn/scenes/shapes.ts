import type { Scene } from '../types';
import { REST, middle, queue, service, store } from './kit';

const orders = service('orders', 110, 108, 'Orders');
const ordersDb = store('orders-db', 338, 176, 'Orders DB');

export const addShape: Scene = {
  label: 'The pointer rests on the canvas, S is pressed and a Service appears under it; then D, and a Data Store appears.',
  frames: [
    { ms: 700, step: 'Point where it goes', cursor: { ...REST, travel: 0 } },
    { ms: 800, cursor: { x: 182, y: 137 } },
    { ms: 1200, step: 'Press a letter', overlay: { kind: 'keys', keys: ['s'] }, add: { nodes: [orders] } },
    { ms: 800, cursor: { x: 400, y: 216 } },
    { ms: 1500, overlay: { kind: 'keys', keys: ['d'] }, add: { nodes: [ordersDb] } },
  ],
};

const topic = queue('events', 70, 128);
const cache = store('cache', 350, 110, 'Sessions');

export const pickAKind: Scene = {
  label: 'A queue is selected and its type changed from Queue to Topic; then a data store is changed to Cache.',
  frames: [
    { ms: 800, step: 'Select a shape', add: { nodes: [topic, cache] }, cursor: { ...REST, travel: 0 } },
    { ms: 700, cursor: { ...middle(topic), click: true }, select: ['events'] },
    {
      ms: 900,
      step: 'Choose its type',
      select: ['events'],
      overlay: { kind: 'popover', at: { x: 134, y: 112 }, controls: [{ type: 'select', label: 'Queue type', value: 'Queue' }] },
    },
    {
      ms: 1100,
      overlay: {
        kind: 'popover',
        at: { x: 134, y: 112 },
        controls: [{ type: 'select', label: 'Queue type', value: 'Queue', options: ['Queue', 'Topic', 'Stream'], highlight: 'Topic' }],
      },
    },
    { ms: 1000, update: { nodes: { events: { queueKind: 'topic' } } } },
    { ms: 700, step: 'Same idea for stores', cursor: { ...middle(cache), click: true }, select: ['cache'] },
    {
      ms: 1200,
      overlay: {
        kind: 'popover',
        at: { x: 412, y: 94 },
        controls: [
          { type: 'select', label: 'Data Store type', value: 'Generic', options: ['Generic', 'SQL', 'Cache'], highlight: 'Cache' },
        ],
      },
    },
    { ms: 1700, update: { nodes: { cache: { databaseKind: 'cache' } } }, select: [] },
  ],
};

const noteHost = service('host', 200, 188, 'Orders');
const note = {
  id: 'note',
  type: 'note' as const,
  x: 330,
  y: 40,
  width: 176,
  height: 56,
  text: 'Retries twice, then gives up.',
};

export const attachNote: Scene = {
  label: 'A note is dragged onto the Orders service and held; a pill says Attach to Orders, and on release the note becomes a small chip on the service.',
  frames: [
    { ms: 900, step: 'Drag a note onto a shape', add: { nodes: [noteHost, note] }, cursor: { ...REST, travel: 0 } },
    { ms: 700, cursor: { x: 420, y: 68 } },
    { ms: 400, cursor: { x: 420, y: 68, down: true }, select: ['note'] },
    { ms: 900, update: { nodes: { note: { x: 210, y: 176 } } }, cursor: { x: 300, y: 204, down: true, travel: 860 } },
    {
      ms: 1300,
      step: 'Hold until it docks',
      select: ['host'],
      overlay: { kind: 'pill', at: { x: 272, y: 160 }, text: 'Attach to Orders' },
    },
    { ms: 1800, step: 'It rides along', remove: ['note'], chips: { host: ['note'] }, select: [], cursor: { x: 330, y: 300 } },
  ],
};

const a = service('a', 100, 118, 'Orders');
const b = service('b', 316, 118, 'Payments');

export const boundary: Scene = {
  label: 'Two services are marquee-selected, the group shortcut is pressed, and a Checkout boundary is drawn around them.',
  frames: [
    { ms: 800, step: 'Select a few shapes', add: { nodes: [a, b] }, cursor: { x: 80, y: 92, travel: 0 } },
    { ms: 400, cursor: { x: 80, y: 92, down: true } },
    {
      ms: 900,
      overlay: { kind: 'marquee', at: { x: 80, y: 92 }, width: 400, height: 104 },
      cursor: { x: 480, y: 196, down: true, travel: 860 },
    },
    { ms: 700, select: ['a', 'b'], cursor: { x: 486, y: 226 } },
    { ms: 1000, step: 'Group them', overlay: { kind: 'keys', keys: ['mod', 'g'] } },
    {
      ms: 1900,
      add: {
        nodes: [{ id: 'domain', type: 'group', x: 76, y: 70, width: 408, height: 136, text: 'Checkout', boundaryPreset: 'domain' }],
      },
      select: ['domain'],
    },
  ],
};
