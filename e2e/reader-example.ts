import { createDocument, createNode } from '../src/document/factory';
import { createOpenPoint } from '../src/document/openPoints';
import { buildStarter } from '../src/starters/build';
import { ORDER_PROCESSING } from '../src/starters/order-processing';

/** A real document for exercising reading context with and without a walkthrough. */
export function createReaderExample(withFlow = false) {
  const file = createDocument('Order processing — reading example');
  const built = buildStarter(ORDER_PROCESSING, { x: 0, y: 0 });
  file.nodes = built.nodes;
  file.edges = built.edges;
  file.flows = withFlow ? built.flows : [];
  const [api, , worker, db] = file.nodes;
  api!.attachments = [{ id: 'at-api-note', type: 'note', text: 'Acknowledge an accepted order before background processing begins.' }];
  api!.inside = { nodes: [createNode({ type: 'note', x: 0, y: 0, text: 'Keep the order contract small: order ID, line items and correlation ID.' })], edges: [], flows: [], viewport: file.viewport };
  worker!.attachments = [{ id: 'at-write-decision', type: 'note', noteKind: 'decision', text: 'Use idempotent writes so retries cannot create a second order.' }];
  const pending = createOpenPoint('awaiting', [{ kind: 'node', id: db!.id }], 'Confirm how long completed orders should be retained.')!;
  const resolved = { ...createOpenPoint('tentative', [{ kind: 'node', id: api!.id }], 'How should order IDs be generated?')!, resolved: true as const, resolution: 'The API assigns UUIDs before publishing work.' };
  file.openPoints = [pending, resolved];
  return file;
}
