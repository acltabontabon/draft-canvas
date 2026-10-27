import { describe, expect, it } from 'vitest';
import { analyzeTraffic, type TrafficAnalysis, type TrafficInsight } from '../../src/traffic';
import { edge, node } from './helpers';

const HONESTY = /\brps\b|requests per second|p9\d|p50|ms\b|latency of \d|overload|saturat|bottleneck/i;

function insightsOf(analysis: TrafficAnalysis, kind: TrafficInsight['kind']): TrafficInsight[] {
  return analysis.insights.filter((insight) => insight.kind === kind);
}

describe('traffic insights value', () => {
  it('merges convergence nodes that share exactly the same journeys', () => {
    const customer = node('customer', 'actor', { text: 'Customer' });
    const operator = node('operator', 'actor', { text: 'Operator' });
    const checkout = node('checkout', 'service', { text: 'Checkout' });
    const inventory = node('inventory', 'service', { text: 'Inventory' });
    const analysis = analyzeTraffic({
      nodes: [customer, operator, checkout, inventory],
      edges: [
        edge('customer-checkout', customer.id, checkout.id, { semantic: 'calls' }),
        edge('operator-checkout', operator.id, checkout.id, { semantic: 'calls' }),
        edge('customer-inventory', customer.id, inventory.id, { semantic: 'calls' }),
        edge('operator-inventory', operator.id, inventory.id, { semantic: 'calls' }),
      ],
    });

    const convergence = insightsOf(analysis, 'convergence');

    expect(convergence).toHaveLength(1);
    expect(convergence[0]?.nodeIds).toEqual(expect.arrayContaining([checkout.id, inventory.id, customer.id, operator.id]));
    expect(convergence[0]?.text).toContain('Customer and Operator');
  });

  it('writes one hub finding per way in, each naming whose', () => {
    const customer = node('customer', 'actor', { text: 'Customer' });
    const operator = node('operator', 'actor', { text: 'Operator' });
    const checkout = node('checkout', 'service', { text: 'Checkout' });
    const payments = node('payments', 'service', { text: 'Payments' });
    const shipping = node('shipping', 'service', { text: 'Shipping' });
    const inventory = node('inventory', 'service', { text: 'Inventory' });
    const catalog = node('catalog', 'service', { text: 'Catalog' });
    const recommendations = node('recommendations', 'service', { text: 'Recommendations' });
    const analysis = analyzeTraffic({
      nodes: [customer, operator, checkout, payments, shipping, inventory, catalog, recommendations],
      edges: [
        edge('customer-checkout', customer.id, checkout.id, { semantic: 'calls' }),
        edge('operator-inventory', operator.id, inventory.id, { semantic: 'calls' }),
        edge('checkout-payments', checkout.id, payments.id, { semantic: 'calls' }),
        edge('checkout-shipping', checkout.id, shipping.id, { semantic: 'calls' }),
        edge('inventory-catalog', inventory.id, catalog.id, { semantic: 'calls' }),
        edge('inventory-recommendations', inventory.id, recommendations.id, { semantic: 'calls' }),
      ],
    });

    const hubs = insightsOf(analysis, 'hub');

    // Two entrances, two notes: one "only way in" beside one of them would read as the only entrance.
    expect(hubs.map((hub) => hub.focus)).toEqual([[checkout.id], [inventory.id]]);
    expect(hubs.map((hub) => hub.note)).toEqual(['only way in for Customer', 'only way in for Operator']);
    expect(hubs[0]?.text).toContain('while Operator comes in another way');
  });

  it('calls out a direct and indirect hit on the same store', () => {
    const checkout = node('checkout', 'service', { text: 'Checkout' });
    const inventory = node('inventory', 'service', { text: 'Inventory' });
    const database = node('database', 'database', { databaseKind: 'sql', text: 'PostgreSQL' });
    const analysis = analyzeTraffic({
      nodes: [checkout, inventory, database],
      edges: [
        edge('checkout-database', checkout.id, database.id, { semantic: 'reads' }),
        edge('checkout-inventory', checkout.id, inventory.id, { semantic: 'calls' }),
        edge('inventory-database', inventory.id, database.id, { semantic: 'reads' }),
      ],
    });

    const amplification = insightsOf(analysis, 'amplification');

    expect(amplification).toHaveLength(1);
    expect(amplification[0]?.text).toContain('Checkout reaches PostgreSQL along 2 routes');
    expect(amplification[0]?.text).toContain('directly and through Inventory');
  });

  it('does not call separate fan-out branches amplification when they only reconverge', () => {
    const web = node('web', 'service', { text: 'Web' });
    const catalog = node('catalog', 'service', { text: 'Catalog' });
    const checkout = node('checkout', 'service', { text: 'Checkout' });
    const database = node('database', 'database', { databaseKind: 'sql', text: 'PostgreSQL' });
    const analysis = analyzeTraffic({
      nodes: [web, catalog, checkout, database],
      edges: [
        edge('web-catalog', web.id, catalog.id, { semantic: 'calls' }),
        edge('web-checkout', web.id, checkout.id, { semantic: 'calls' }),
        edge('catalog-database', catalog.id, database.id, { semantic: 'reads' }),
        edge('checkout-database', checkout.id, database.id, { semantic: 'reads' }),
      ],
    });

    expect(insightsOf(analysis, 'amplification')).toEqual([]);
  });

  it('reports an external synchronous dependency only when no failure or fallback is drawn', () => {
    const caller = node('caller', 'service', { text: 'Checkout' });
    const external = node('external', 'service', { serviceKind: 'external', text: 'Payments API' });
    const withoutFallback = analyzeTraffic({
      nodes: [caller, external],
      edges: [edge('caller-external', caller.id, external.id, { semantic: 'calls', kind: 'sync' })],
    });
    expect(insightsOf(withoutFallback, 'external-on-sync')).toHaveLength(1);

    const fallback = node('fallback', 'service', { text: 'Fallback' });
    const withFallback = analyzeTraffic({
      nodes: [caller, external, fallback],
      edges: [
        edge('caller-external', caller.id, external.id, { semantic: 'calls', kind: 'sync' }),
        edge('caller-fallback', caller.id, fallback.id, { semantic: 'calls', kind: 'fallback' }),
      ],
    });
    expect(insightsOf(withFallback, 'external-on-sync').map((insight) => [insight.severity, insight.note])).toEqual([['unknown', 'fallback covers this?']]);
  });

  it('merges synchronous chains whose tails are the same', () => {
    const web = node('web', 'service', { text: 'Web' });
    const mobile = node('mobile', 'service', { text: 'Mobile' });
    const webBff = node('web-bff', 'service', { text: 'Web BFF' });
    const mobileBff = node('mobile-bff', 'service', { text: 'Mobile BFF' });
    const catalog = node('catalog', 'service', { text: 'Catalog' });
    const inventory = node('inventory', 'service', { text: 'Inventory' });
    const database = node('database', 'database', { databaseKind: 'sql', text: 'PostgreSQL' });
    const analysis = analyzeTraffic({
      nodes: [web, mobile, webBff, mobileBff, catalog, inventory, database],
      edges: [
        edge('web-bff', web.id, webBff.id, { semantic: 'calls' }),
        edge('mobile-bff', mobile.id, mobileBff.id, { semantic: 'calls' }),
        edge('web-catalog', webBff.id, catalog.id, { semantic: 'calls' }),
        edge('mobile-catalog', mobileBff.id, catalog.id, { semantic: 'calls' }),
        edge('catalog-inventory', catalog.id, inventory.id, { semantic: 'calls' }),
        edge('inventory-database', inventory.id, database.id, { semantic: 'reads' }),
      ],
    });

    const chains = insightsOf(analysis, 'sync-chain');

    expect(chains).toHaveLength(1);
    expect(chains[0]?.text).toContain('Mobile and Web requests can wait on');
    expect(chains[0]?.text).toContain('Catalog → Inventory → PostgreSQL');
  });

  it('distinguishes writers and readers in shared-store text', () => {
    const writer = node('writer', 'service', { text: 'Order Writer' });
    const reader = node('reader', 'service', { text: 'Order Reader' });
    const database = node('database', 'database', { databaseKind: 'sql', text: 'Orders' });
    const analysis = analyzeTraffic({
      nodes: [writer, reader, database],
      edges: [
        edge('writer-database', writer.id, database.id, { semantic: 'writes' }),
        edge('reader-database', reader.id, database.id, { semantic: 'reads' }),
      ],
    });

    const shared = insightsOf(analysis, 'shared-dependency');

    expect(shared).toHaveLength(1);
    expect(shared[0]?.text).toContain('Order Writer writes Orders');
    expect(shared[0]?.text).toContain('Order Reader reads it');
  });
});

describe('traffic insight honesty sweep', () => {
  it.each([
    {
      name: 'online store',
      nodes: [
        node('shopper', 'actor', { text: 'Shopper' }),
        node('web', 'service', { text: 'Web' }),
        node('checkout', 'service', { text: 'Checkout' }),
        node('catalog', 'service', { text: 'Catalog' }),
        node('inventory', 'service', { text: 'Inventory' }),
        node('payments', 'service', { serviceKind: 'external', text: 'Payments API' }),
        node('database', 'database', { databaseKind: 'sql', text: 'PostgreSQL' }),
      ],
      edges: [
        edge('shopper-web', 'shopper', 'web', { semantic: 'calls' }),
        edge('web-checkout', 'web', 'checkout', { semantic: 'calls' }),
        edge('web-catalog', 'web', 'catalog', { semantic: 'calls' }),
        edge('checkout-inventory', 'checkout', 'inventory', { semantic: 'calls' }),
        edge('checkout-payments', 'checkout', 'payments', { semantic: 'calls' }),
        edge('checkout-database', 'checkout', 'database', { semantic: 'writes' }),
        edge('inventory-database', 'inventory', 'database', { semantic: 'reads' }),
        edge('catalog-database', 'catalog', 'database', { semantic: 'reads' }),
      ],
    },
    {
      name: 'event-driven pipeline',
      nodes: [
        node('producer', 'service', { text: 'Order Service' }),
        node('topic', 'queue', { queueKind: 'topic', text: 'Order Events' }),
        node('indexer', 'service', { serviceKind: 'worker', text: 'Search Indexer' }),
        node('notifier', 'service', { serviceKind: 'worker', text: 'Notifier' }),
        node('search', 'database', { databaseKind: 'search-index', text: 'Search Index' }),
        node('email', 'service', { serviceKind: 'external', text: 'Email Provider' }),
      ],
      edges: [
        edge('producer-topic', 'producer', 'topic', { semantic: 'publishes' }),
        edge('topic-indexer', 'topic', 'indexer', { semantic: 'consumes' }),
        edge('topic-notifier', 'topic', 'notifier', { semantic: 'consumes' }),
        edge('indexer-search', 'indexer', 'search', { semantic: 'indexes' }),
        edge('notifier-email', 'notifier', 'email', { semantic: 'calls' }),
      ],
    },
    {
      name: 'BFF',
      nodes: [
        node('client', 'actor', { text: 'Mobile App' }),
        node('bff', 'service', { text: 'Mobile BFF' }),
        node('catalog', 'service', { text: 'Catalog' }),
        node('reviews', 'service', { text: 'Reviews' }),
        node('recommendations', 'service', { text: 'Recommendations' }),
        node('catalog-db', 'database', { databaseKind: 'sql', text: 'Catalog DB' }),
      ],
      edges: [
        edge('client-bff', 'client', 'bff', { semantic: 'calls' }),
        edge('bff-catalog', 'bff', 'catalog', { semantic: 'calls' }),
        edge('bff-reviews', 'bff', 'reviews', { semantic: 'calls' }),
        edge('bff-recommendations', 'bff', 'recommendations', { semantic: 'calls' }),
        edge('catalog-db', 'catalog', 'catalog-db', { semantic: 'reads' }),
      ],
    },
  ])('$name never invents rate, timing or capacity claims', ({ nodes, edges }) => {
    const analysis = analyzeTraffic({ nodes, edges });
    expect(analysis.insights.map((insight) => insight.text)).not.toEqual(expect.arrayContaining([expect.stringMatching(HONESTY)]));
  });
});


describe('shared store semantic limits', () => {
  it('does not turn mixed or unspecified operations into reads or infer shared schema', () => {
    const nodes = [node('a', 'service', { text: 'Mixed' }), node('b', 'service', { text: 'Unspecified' }), node('db', 'database', { text: 'Store' })];
    const analysis = analyzeTraffic({ nodes, edges: [edge('a-db', 'a', 'db', { semantic: 'readsWrites' }), edge('b-db', 'b', 'db')] });
    const shared = insightsOf(analysis, 'shared-dependency')[0]!;
    expect(shared.text).toContain('Mixed and Unspecified access Store');
    expect(shared.text).not.toMatch(/reads|writes|no single service clearly owns/);
    expect(shared.text).toContain('does not establish shared tables');
  });
});
