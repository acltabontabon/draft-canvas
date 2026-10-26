import { describe, expect, it } from 'vitest';
import { trafficCalloutFor } from '../src/canvas/trafficCallout';
import { analyzeTraffic } from '../src/traffic';
import { edge, node } from './traffic/helpers';

describe('traffic field note', () => {
  it('lists the same waiting services and stalled journeys once', () => {
    const nodes = [node('web', 'service', { text: 'Web Storefront' }), node('mobile', 'service', { text: 'Mobile BFF' }), node('checkout', 'service', { text: 'Checkout' })];
    const analysis = analyzeTraffic({ nodes, edges: [edge('web-checkout', 'web', 'checkout', { semantic: 'calls' }), edge('mobile-checkout', 'mobile', 'checkout', { semantic: 'calls' })] });
    const note = trafficCalloutFor(analysis, nodes, 'checkout', [])!;
    expect(note.metric).toBe('2 paths');
    expect(note.sources.map((source) => source.count)).toEqual(['1 path', '1 path']);
    expect(note.sections).toHaveLength(1);
    expect(note.sections[0]!.detail?.text).toBe('Calls wait · journeys stall');
    expect(note.sections[0]!.items.map((item) => item.text).sort()).toEqual(['Mobile BFF', 'Web Storefront']);
  });

  it('keeps different waiting services and origin journeys distinct', () => {
    const nodes = [node('customer', 'actor', { text: 'Customer' }), node('web', 'service', { text: 'Web Storefront' }), node('checkout', 'service', { text: 'Checkout' })];
    const analysis = analyzeTraffic({ nodes, edges: [edge('customer-web', 'customer', 'web', { semantic: 'calls' }), edge('web-checkout', 'web', 'checkout', { semantic: 'calls' })] });
    const note = trafficCalloutFor(analysis, nodes, 'checkout', [])!;
    expect(note.sections.map((section) => ({ label: section.label, names: section.items.map((item) => item.text) }))).toEqual([
      { label: 'Calls waiting', names: ['Web Storefront'] },
      { label: 'Journeys stalled', names: ['Customer'] },
    ]);
  });

  it('distinguishes a non-runtime shape from an unreachable runtime shape', () => {
    const nodes = [node('note', 'note', { text: 'A note' }), node('unused', 'service', { text: 'Unused' }), node('web', 'service'), node('db', 'database')];
    const analysis = analyzeTraffic({ nodes, edges: [edge('read', 'web', 'db', { semantic: 'reads' })] });
    expect(trafficCalloutFor(analysis, nodes, 'note', [])!.metric).toBe('Outside runtime');
    expect(trafficCalloutFor(analysis, nodes, 'unused', [])!.summary?.text).toBe('No counted path reaches this shape.');
  });
});
