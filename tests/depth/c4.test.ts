import { describe, expect, it } from 'vitest';
import { classify, levelAdvisories } from '../../src/depth/c4';
import { createNode } from '../../src/document/factory';
import type { DraftNode } from '../../src/document/types';

const node = (input: Partial<DraftNode> & Pick<DraftNode, 'type'>): DraftNode => ({ ...createNode({ x: 0, y: 0, ...input }), ...input });

describe('C4 classification (derived, never stored)', () => {
  it('reads a service by the level of the view it is in', () => {
    const service = node({ type: 'service' });
    expect(classify(service, { level: 'context' })?.role).toBe('software-system');
    expect(classify(service, { level: 'container' })?.role).toBe('container');
    // A component view may hold supporting containers: a service there can't be told apart.
    expect(classify(service, { level: 'component' })?.role).toBe('unspecified');
    expect(classify(service, { level: undefined })?.role).toBe('unspecified');
  });

  it('keeps role and scope apart: an external system is a software system at every level, and external', () => {
    const external = node({ type: 'service', serviceKind: 'external' });
    for (const level of ['context', 'container', 'component'] as const) {
      expect(classify(external, { level })).toMatchObject({ role: 'software-system', scope: 'external', derived: true });
    }
  });

  it('reads data stores and queues as containers inside a system, never components', () => {
    for (const type of ['database', 'queue'] as const) {
      expect(classify(node({ type }), { level: 'container' })?.role).toBe('container');
      expect(classify(node({ type }), { level: 'component' })?.role).toBe('container');
      expect(classify(node({ type }), { level: 'context' })?.role).toBe('unspecified');
    }
  });

  it('reads people as people and third-party actors as external systems', () => {
    expect(classify(node({ type: 'actor', actorKind: 'human' }), { level: undefined })?.role).toBe('person');
    expect(classify(node({ type: 'actor', actorKind: 'thirdParty' }), { level: 'context' })).toMatchObject({ role: 'software-system', scope: 'external' });
    expect(classify(node({ type: 'actor', actorKind: 'device' }), { level: 'context' })?.role).toBe('unspecified');
  });

  it('reads a component as a component only in a component view', () => {
    expect(classify(node({ type: 'component' }), { level: 'component' })?.role).toBe('component');
    expect(classify(node({ type: 'component' }), { level: 'container' })?.role).toBe('unspecified');
  });

  it('takes scope from native containment only: a room owner or a system boundary, never geometry', () => {
    const owner = node({ type: 'service', text: 'Payments' });
    const boundary = node({ type: 'group', boundaryPreset: 'system', text: 'Billing' });
    expect(classify(node({ type: 'service' }), { level: 'container', insideOwner: owner })).toMatchObject({ scope: 'internal' });
    expect(classify(node({ type: 'service' }), { level: 'container', systemBoundary: boundary })?.basis).toContain('Billing');
    expect(classify(node({ type: 'service' }), { level: 'container' })?.scope).toBe('unspecified');
  });

  it('says nothing about annotation and structure', () => {
    for (const type of ['note', 'text', 'code', 'group', 'ellipse'] as const) expect(classify(node({ type }), { level: 'context' })).toBeUndefined();
  });

  it('advises about mixed levels without refusing them', () => {
    const advice = levelAdvisories([node({ type: 'component' }), node({ type: 'database' })], 'context');
    expect(advice).toHaveLength(2);
    expect(levelAdvisories([node({ type: 'component' })], 'component')).toEqual([]);
  });
});
